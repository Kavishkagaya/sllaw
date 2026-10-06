#!/usr/bin/env python3
"""Step 3, Jev path: classify every body block with Jev (TypeSafe) through Vercel AI Gateway.

  python3 -m etl.label raw.json.gz [...] --out DIR            # needs AI_GATEWAY_API_KEY in .env
  python3 -m etl.label raw.json.gz --dry-run                  # print one request + token estimate

Per block, three atomic questions (Jev answers all questions of a request in parallel and
independently, so each one must stand alone):
  t<i> type      choice: front | section_start | provision | part_heading | chapter_heading |
                         heading_title | schedule_heading | schedule_content | furniture
  q<i> quoted    yes/no: text an amendment inserts into another law (a quoted section looks
                         exactly like a real one, so this can't be one of the types)
  c<i> continues yes/no: carries on the previous block's sentence across a page/column break
Code does what Jev can't (it can't count or compare numbers): section numbers, paragraph labels,
marginal notes by alignment, all in etl.structure.assemble().

Windows of WINDOW blocks go in order within a document, each carrying the blocks around it and
Jev's labels for the previous ones (an amendment's quote can open pages earlier); documents run
in parallel. Then every block where Jev and the rules (etl.structure.rule_kinds) disagree, or
Jev is unsure, is asked again in a focused request with a gateway evaluation fallback: if Jev
is still unsure, the gateway reruns that request on FALLBACK, a language model.
Output per Act: <name>.labels.json (every answer, both labellers, final) and <name>.jev.act.json.
"""
import argparse, gzip, json, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

from etl.structure import assemble, blocks, rule_kinds

load_dotenv()
# Two services, same typed-question format (Clef copied Jev's):
#   vercel:     Jev through Vercel AI Gateway; pass 2 escalates unsure answers to FALLBACK (an LLM)
#   cloudflare: Clef on Workers AI (optionally through Cloudflare AI Gateway CF_AI_GATEWAY);
#               pass 1 on clef-flash (9B), pass 2 re-asks on clef (27B). No LLM fallback there.
PROVIDER = "vercel"
MODEL = "typesafe-ai/jev"
FALLBACK = "anthropic/claude-sonnet-5.5"     # listed by the gateway's /v1/models (2026-10-04)
CF = {"pass1": "clef-flash", "pass2": "clef", "usd_per_m": {"clef-flash": 0.09, "clef": 0.24}}
WINDOW, BEFORE, AFTER = 20, 12, 4             # 3 questions per block -> 60 per request
SURE = 0.8                                    # below this confidence (or P between 0.2-0.8) is "unsure"

TYPES = {
    "front": "Before the enacted text: the Act's title page, '[Certified on ...]', the L.D.-O. number, "
             "the long title 'AN ACT TO ...', a preamble 'WHEREAS ...', or the enacting formula 'BE it enacted ...'",
    "section_start": "Begins a numbered section: starts with the section number and a full stop, e.g. "
                     "'5. (1) The Minister may ...' or '12A. Notwithstanding ...'",
    "provision": "Text inside a section that does not begin it: a subsection '(2) ...', a paragraph '(a) ...', "
                 "a sub-paragraph '(i) ...', a proviso 'Provided that ...', a definition, an explanation, "
                 "or the rest of a sentence carried over from the previous block",
    "part_heading": "A Part heading line such as 'PART II', possibly followed by its title on the same line",
    "chapter_heading": "A Chapter heading line such as 'CHAPTER IV', possibly with its title on the same line",
    "heading_title": "A centred title line on its own: the title under a PART or CHAPTER heading, "
                     "or a cross-heading over a group of sections, e.g. 'ESTABLISHMENT OF THE COMMISSION'",
    "schedule_heading": "The heading that starts a Schedule, e.g. 'SCHEDULE', 'FIRST SCHEDULE', 'SCHEDULE A', "
                        "sometimes with a reference like '[Section 41]'",
    "schedule_content": "Content of a Schedule after its heading: listed items, forms, tables, rates, notes",
    "furniture": "Not law at all: a running header with the Act's name, a page number, a printer's code "
                 "like '2-PL 010337', a price, or back-cover sales text",
}
QUOTED = ("Is this block text quoted by an amending provision, i.e. words, a definition, a section, "
          "a schedule or an item being inserted into or substituted in ANOTHER law (it usually follows "
          "'... the following ... :-' and is enclosed in quote marks that may span many blocks)? "
          "Answer no for this Act's own provisions, including its own definitions of 'terms'.")
CONT = ("Does this block continue the sentence of the block just before it, broken only by a page "
        "or column break (it does not start a new numbered or lettered item)?")
STATE_NOTE = ("Blocks of one Sri Lankan Act of Parliament in reading order, extracted from a two-column "
              "PDF: body text plus marginal notes (short section titles printed beside a section's first "
              "line). 'indent' is the block's left edge in points from the body column's left edge. "
              "'context_before' carries labels already given; questions are only about 'blocks'.")


def short(t, head=500, tail=200):
    """Long blocks keep both ends: a quote's opening and closing marks decide 'quoted'."""
    return t if len(t) <= head + tail + 5 else t[:head] + " … " + t[-tail:]


def view(bs, k, notes, label=None):
    b = bs[k]
    v = {"id": f"b{k}", "page": b["page"], **({"indent": b["indent"]} if "indent" in b else {}), "text": short(b["text"])}
    if b["label"] in ("section_header", "list_item", "table", "form", "document_index"):
        v["layout"] = b["label"]
    if (n := notes.get(k)):
        v["marginal_note"] = n
    if label:
        v["label"] = label
    return v


def endpoint(model):
    if PROVIDER == "vercel":
        return "https://ai-gateway.vercel.sh/v1/evaluate", os.environ["AI_GATEWAY_API_KEY"]
    acct = os.environ.get("CF_ACCOUNT_ID") or os.environ["R2_ACCOUNT_ID"]
    gw = os.environ.get("CF_AI_GATEWAY") if CF.get("gateway") else None   # 401s with a Workers-AI-only token
    base = (f"https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/workers-ai" if gw
            else f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run")
    return f"{base}/@cf/cloudflare/{model}", os.environ["CLOUDFLARE_API_TOKEN"]


def evaluate(state, questions, fallback=None, tries=4):
    if PROVIDER == "vercel":
        model = MODEL
        body = {"model": MODEL, "state": state, "questions": questions,
                "providerOptions": {"gateway": {"zeroDataRetention": True,
                                                **({"models": [fallback]} if fallback else {})}}}
    else:                                   # Clef calls a yes/no question "noul"
        model = CF["pass2" if fallback else "pass1"]
        body = {"state": state, "questions": {q: {**v, "type": "noul" if v["type"] == "boolean" else v["type"]}
                                              for q, v in questions.items()}}
    url, key = endpoint(model)
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json",
        "User-Agent": "sllaw-etl/1.0"})      # Cloudflare answers 1010 to Python's default agent
    for a in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                resp = json.load(r)
            resp = resp.get("result", resp) if PROVIDER == "cloudflare" else resp   # Workers AI wraps it
            resp.setdefault("model", model)
            return resp
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429 or a == tries - 1:
                raise RuntimeError(f"{e.code}: {e.read().decode()[:500]}")
        except (urllib.error.URLError, TimeoutError):
            if a == tries - 1:
                raise
        time.sleep(2 ** a)


def prob(a):
    """A yes/no answer in any of the shapes seen: 0.87 | {probability} | {noul}."""
    return a if isinstance(a, (int, float)) else a.get("probability", a.get("noul"))


def read(resp, k):
    """-> {type, type_p, type_conf, quoted, cont} for block k from one response. A choice comes
    as {choice, probabilities, confidence?} (Jev) or as a bare {option: probability} map (Clef docs)."""
    ans = resp["answers"]
    conf = ((resp.get("providerMetadata") or {}).get("typesafe") or {}).get("confidence") or {}
    t = ans[f"t{k}"]
    probs = t.get("probabilities") if "choice" in t else {o: v for o, v in t.items() if isinstance(v, (int, float))}
    choice = t.get("choice") or max(probs, key=probs.get)
    return {"type": choice, "type_p": (probs or {}).get(choice),
            "type_conf": t.get("confidence", conf.get(f"t{k}")),
            "quoted": prob(ans[f"q{k}"]), "cont": prob(ans[f"c{k}"])}


def questions(ks):
    q = {}
    for k in ks:
        q[f"t{k}"] = {"type": "choice", "instructions": f"What kind of block is b{k}?", "criteria": TYPES}
        q[f"q{k}"] = {"type": "boolean", "instructions": f"Block b{k}: {QUOTED}"}
        q[f"c{k}"] = {"type": "boolean", "instructions": f"Block b{k}: {CONT}"}
    return q


def kind(a):
    """Jev's three answers -> one label of etl.structure.KINDS."""
    t = {"provision": "section_text", "schedule_content": "schedule_text"}.get(a["type"], a["type"])
    return "quoted" if a["quoted"] >= 0.5 and t not in ("front", "furniture") else t


def same(a, b):
    """Title-page boilerplate is front matter to the rules and furniture to the model: both drop it."""
    return a == b or {a, b} == {"front", "furniture"}


def unsure(a):
    return ((a["type_conf"] is not None and a["type_conf"] < SURE) or (a["type_p"] or 0) < SURE
            or 1 - SURE < a["quoted"] < SURE)


def label_doc(raw, dry=False):
    bs = blocks(raw)
    body = [k for k, b in enumerate(bs) if b["role"] == "body"]
    # each marginal note goes with the body block level with its first line (code, not Jev)
    notes = {}
    for m in (b for b in bs if b["role"] == "margin"):
        k = min((k for k in body if bs[k]["page"] == m["page"]),
                key=lambda k: abs(bs[k]["bbox"][1] - m["bbox"][1]), default=None)
        if k is not None and abs(bs[k]["bbox"][1] - m["bbox"][1]) < 12:
            notes[k] = (notes.get(k, "") + " " + m["text"]).strip()
    title = next((b["text"] for b in bs if b["role"] == "furniture" and "Act" in b["text"]), None)
    rules, rule_warn = rule_kinds(bs)
    jev, usage = {}, {"requests": 0, "input_tokens": 0, "cost": 0.0, "fallbacks": 0}

    def ask(ks, fallback=None):
        i0, i1 = body.index(ks[0]), body.index(ks[-1])
        state = {"about": STATE_NOTE, "act": title,
                 "context_before": [view(bs, k, notes, kind(jev[k]) if k in jev else None)
                                    for k in body[max(0, i0 - BEFORE):i0]],
                 "blocks": [view(bs, k, notes) for k in body[i0:i1 + 1]],   # asked + the ones between
                 "context_after": [view(bs, k, notes) for k in body[i1 + 1:i1 + 1 + AFTER]]}
        if dry:
            return state
        r = evaluate(state, questions(ks), fallback)
        usage["requests"] += 1
        u = r.get("usage") or {}
        tok = u.get("inputTokens", u.get("input_tokens", 0))
        usage["input_tokens"] += tok
        g = (r.get("providerMetadata") or {}).get("gateway") or {}
        usage["cost"] += float(g.get("cost") or 0) if PROVIDER == "vercel" else tok * CF["usd_per_m"].get(r["model"], 0.24) / 1e6
        usage["fallbacks"] += r.get("model") not in (MODEL, CF["pass1"])
        return {k: {**read(r, k), "model": r.get("model")} for k in ks}

    if dry:
        st = ask(body[:WINDOW])
        req = {"model": MODEL, "state": st, "questions": questions(body[:WINDOW])}
        n = len(json.dumps(req)) // 4
        print(json.dumps(req, ensure_ascii=False, indent=1)[:6000])
        print(f"\n~{n} tokens for this request; {len(body)} body blocks -> "
              f"{-(-len(body) // WINDOW)} requests, ~{n * -(-len(body) // WINDOW)} tokens", file=sys.stderr)
        return None

    for i in range(0, len(body), WINDOW):                     # pass 1: every block, in order
        jev.update(ask(body[i:i + WINDOW]))
    first = dict(jev)
    doubt = [k for k in body if not same(kind(jev[k]), rules.get(k)) or unsure(jev[k])]
    fb = {"model": FALLBACK, "when": {"any": [{"confidenceBelow": SURE},
                                              {"probabilityBetween": [1 - SURE, SURE]}]}}
    groups = []                                               # pass 2: re-ask the doubtful ones,
    for k in doubt:                                           # nearby ones together, spans <= 30 blocks
        if groups and len(groups[-1]) < WINDOW and body.index(k) - body.index(groups[-1][0]) < 30:
            groups[-1].append(k)
        else:
            groups.append([k])
    for g in groups:
        jev.update(ask(g, fb))

    final = {k: kind(jev[k]) for k in body}
    cont = {k for k in body if jev[k]["cont"] >= 0.5}
    doc = assemble(bs, final, rule_warn, cont)
    review = [k for k in body if not same(final[k], rules.get(k))]
    if review:
        doc["warnings"].append(f"{len(review)} blocks where Jev and the rules disagree (Jev's label used)")
    labels = {"usage": usage, "agree_first_pass": sum(same(kind(first[k]), rules.get(k)) for k in body),
              "blocks": len(body), "doubtful": len(doubt), "disagree_final": len(review),
              "per_block": {f"b{k}": {"text": short(bs[k]["text"], 120, 60), "rules": rules.get(k),
                                      "jev_first": first[k], "jev_final": jev[k], "final": final[k]}
                            for k in body}}
    return labels, doc


def main():
    a = argparse.ArgumentParser()
    a.add_argument("raw", nargs="+")
    a.add_argument("--out", default=".")
    a.add_argument("--dry-run", action="store_true", help="print the first request, call nothing")
    a.add_argument("--workers", type=int, default=8, help="documents in parallel")
    a.add_argument("--provider", choices=("vercel", "cloudflare"), default="vercel")
    a.add_argument("--pass1", default=CF["pass1"], help="cloudflare: model for pass 1 (clef-flash | clef)")
    a.add_argument("--cf-gateway", action="store_true", help="cloudflare: go through AI Gateway CF_AI_GATEWAY")
    args = a.parse_args()
    global PROVIDER
    PROVIDER, CF["pass1"], CF["gateway"] = args.provider, args.pass1, args.cf_gateway
    if args.dry_run:
        label_doc(json.load(gzip.open(args.raw[0])), dry=True)
        return

    def one(f):
        name = Path(f).name.split('.')[0]
        try:
            labels, doc = label_doc(json.load(gzip.open(f)))
        except Exception as e:
            return f"{name}: FAIL {e}"[:300]
        Path(args.out, f"{name}.labels.json").write_text(json.dumps(labels, ensure_ascii=False, indent=1))
        Path(args.out, f"{name}.jev.act.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1))
        u = labels["usage"]
        return (f"{name}: {len(doc['sections'])} sections, rules agree {labels['agree_first_pass']}/{labels['blocks']} "
                f"on pass 1, {labels['doubtful']} re-asked, {labels['disagree_final']} still differ | "
                f"{u['requests']} req, {u['input_tokens']} tok, ${u['cost']:.4f}, {u['fallbacks']} fallbacks"
                + "".join(f"\n    {w}" for w in doc["warnings"][:6]))
    with ThreadPoolExecutor(args.workers) as ex:
        for line in ex.map(one, args.raw):
            print(line, flush=True)


if __name__ == "__main__":
    main()
