#!/usr/bin/env python3
"""The "never worse than today" gate for stages 3-5 and the builder's feedback (docs/PIPELINE_V2.md). Every document
built in memory with the v2 builder, checked (etl.v2.checks), and compared with today's chunks. Read-only: raw from
R2, today's chunks from the work host's Postgres; nothing is written but the run's folder.

  python3 -m etl.v2.gate [--keys act:7/2007,...] [--limit N] [--workers 16] [--diff] [--against <run folder>]
  -> ~/sllaw/logs/v2_gate/<time>/
       issues.jsonl   every issue: key, check, severity, where, page, evidence, cause
       report.jsonl   a row per document: chunks, labels lost/gained, same text, issue counts
       summary.txt    per kind; per check and cause; fixed / new against the previous run
       review.md      the documents to look at first: errors, then warnings, with their issues
       samples/       full chunk lists of a few documents

An issue's identity is (key, check, where, cause): a rerun says which went away (fixed) and which appeared (new),
so a fix shows its effect and a regression shows at once. `label_lost` (error) = a unit label today's build has
and the tree lacks: the gate passes when there is none, or each is reviewed.
"""
import argparse, glob, gzip, hashlib, json, os, re, time, traceback
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor

from dotenv import load_dotenv

from etl.v2 import blocks as b3, checks, chunk as c5, tree as t4
from etl.v2.profiles import profile

load_dotenv(os.path.expanduser("~/sllaw/.env"))
RUNS = os.path.expanduser("~/sllaw/logs/v2_gate")
SAMPLES = {"act:7/2007", "cap:25", "cap:105", "constitution:21", "constitution", "act:21/2006", "act:24/2019",
           "cap:235", "cap1956:203", "law:44/1973", "act:15/1979", "act:12/2026", "gazette:2182/39", "gazette:2235/54"}
_w = {}
gaps = checks.gaps
OVERRIDES = os.path.join(os.path.dirname(__file__), "..", "overrides.json")
GOLD_FILE = os.path.join(os.path.dirname(__file__), "gold_structure.json")
GOLD = {l["key"]: l for l in json.load(open(GOLD_FILE))["laws"]} if os.path.exists(GOLD_FILE) else {}
ACCEPT = {(a["key"], a["check"], a["where"]): a for a in json.load(open(OVERRIDES)).get("accept", [])} \
    if os.path.exists(OVERRIDES) else {}


def _init(diff=False):
    import psycopg2
    from etl.fetch import r2
    _w["diff"] = diff
    _w["db"] = psycopg2.connect(os.environ["DB_LOCAL_URL"])
    _w["s3"], _w["bucket"] = r2(), os.environ["R2_BUCKET"]


def _get(k):
    return json.loads(gzip.decompress(_w["s3"].get_object(Bucket=_w["bucket"], Key=k)["Body"].read()))


def build(row):
    """One document through stages 3-5 -> (prof, engine, paras, stats, tree, info, chunks)."""
    key, title, sha, raw_key, meta = row
    raw = _get(raw_key)
    try:
        lo = _get(f"raw/lighton/{sha}.json.gz")
    except _w["s3"].exceptions.NoSuchKey:
        lo = None
    prof = profile(key, title)
    bs, engine = b3.read(raw, lo, le1980=bool(meta.get("cap")), spread=bool(meta.get("spread")), gazette=bool(prof.get("gazette")))
    paras, st = b3.paragraphs(bs, engine, gazette=bool(prof.get("gazette")))
    tree, info = t4.build(paras, prof, key)
    return prof, engine, paras, st, tree, info, c5.chunks(key, tree, prof)


def one(row):
    key = row[0]
    try:
        with _w["db"].cursor() as cur:
            cur.execute("SELECT label, text FROM chunks WHERE doc_key = %s ORDER BY seq", (key,))
            old = cur.fetchall()
            cur.execute("""SELECT (SELECT jsonb_agg(s->>'num') FROM jsonb_array_elements(doc->'sections') s)
                           FROM acts WHERE key = %s AND doc IS NOT NULL""", (key,))
            structure = (cur.fetchone() or [None])[0]
        _w["db"].rollback()
        prof, engine, paras, st, tree, info, ch = build(row)
        issues = checks.check(key, prof, paras, st, tree, info, ch, structure=structure or None)
        old_labels = Counter(l for l, _ in old if l)
        new_labels = Counter(c["label"] for c in ch if c["label"])
        lost, gained = sorted((old_labels - new_labels).elements()), sorted((new_labels - old_labels).elements())
        # numbers v2 keeps as numbered items of a schedule (a list of monuments, of goods) where today made units
        items = {m[1] for _, u in t4.units(tree) if u["kind"] == "schedule" for c in u["children"]
                 if (m := re.match(r"\s*(\d{1,3}[A-Z]{0,3})\s*\.\s", c["text"]))}
        for l in lost:
            agrees = structure is not None and l not in structure and not l.lower().startswith("schedule")
            quoted = l in info["quoted_schedules"]
            old_text = next((t for x, t in old if x == l), "")
            body = re.sub(r"^\s*\d{1,3}[A-Z]{0,3}\s*\.\s*", "", old_text)[:60]
            if not agrees and not quoted and l not in items and re.match(r"[A-Z]?\s?\d{4,}", body.lstrip()):
                issues.append({"check": "label_lost", "severity": "info", "where": f"{key} {l}", "page": None,
                               "evidence": old_text[:200], "cause": "not a provision: today's unit is a line of numbers (a survey point)"})
                continue
            if not agrees and not quoted and l in items:
                issues.append({"check": "label_lost", "severity": "info", "where": f"{key} {l}", "page": None,
                               "evidence": next((t[:200] for x, t in old if x == l), None),
                               "cause": "schedule item: v2 has it as a numbered item of a schedule, today as a unit"})
                continue
            issues.append({"check": "label_lost", "severity": "info" if agrees or quoted else "error",
                           "where": f"{key} {l}", "page": None, "evidence": next((t[:200] for x, t in old if x == l), None),
                           "cause": "second opinion agrees: the old assembler (which tracks quotes) lacks it too" if agrees
                           else "quoted: a schedule the amending law inserts or substitutes" if quoted
                           else "today's build has it"})
        for i in issues:                                  # reviewed and accepted (etl/overrides.json)
            a = ACCEPT.get((key, i["check"], i["where"])) or ACCEPT.get((key, i["check"], "*"))
            if a and i["severity"] in ("error", "warn"):
                i["severity"], i["cause"] = "accepted", f"{i['cause']} — accepted: {a['reason']} ({a['by']}, {a['at']})"
        if len({c["id"] for c in ch}) != len(ch):
            issues.append({"check": "duplicate_id", "severity": "error", "where": key, "page": None, "evidence": None,
                           "cause": "two chunks with one address"})
        if key in GOLD:                                   # the structure gold set (etl/v2/gold_structure.json)
            g = GOLD[key]
            own, quoted = set(g["own"]), set(g["quoted"])
            mine = {u["label"] for _, u in t4.units(tree) if u["kind"] == "unit"}
            today = {l for l, _ in old if l and re.fullmatch(r"\d+[A-Za-z]*", l)}
            gold = {}
            for who, got in (("v2", mine), ("today", today)):
                gold[who] = {"own": len(own), "found": len(own & got), "extra": sorted(got - own),
                             "quoted_as_unit": sorted(got & quoted)}
            for n in sorted(own - mine, key=lambda x: (len(x), x)):
                issues.append({"check": "gold_missing", "severity": "error", "where": f"{key} section {n}", "page": None,
                               "evidence": None, "cause": "the gold set has this own section, v2 does not"})
            for n in sorted(mine - own, key=lambda x: (len(x), x)):
                issues.append({"check": "gold_extra", "severity": "error", "where": f"{key} section {n}", "page": None,
                               "evidence": None, "cause": ("quoted text read as a unit" if n in quoted else
                                                           "a unit the gold set does not have")})
        old_hash = {hashlib.sha1(t.encode()).hexdigest() for _, t in old}
        res = {"key": key, "kind": prof["kind"], "engine": engine, "paras": len(paras),
               "old_chunks": len(old), "new_chunks": len(ch), "lost": lost, "gained": gained,
               "same_text": sum(c["text_hash"] in old_hash for c in ch), "dropped_words": info["dropped_words"],
               "recovered_words": st["margin_as_body_words"],
               **({"gold": gold} if key in GOLD else {}),
               "issues": dict(Counter(f"{i['check']}:{i['severity']}" for i in issues)),
               "_issues": [{"key": key, **i} for i in issues]}
        if _w.get("diff"):
            res["diff"] = {"only_today": [t[:300] for _, t in old if hashlib.sha1(t.encode()).hexdigest()
                                          not in {c["text_hash"] for c in ch}][:12],
                           "only_v2": [c["text"][:300] for c in ch if c["text_hash"] not in old_hash][:12]}
        if key in SAMPLES:
            res["sample"] = [{k: (v[:400] if k == "text" else v) for k, v in c.items()} for c in ch]
        return res
    except Exception as e:
        _w["db"].rollback()
        return {"key": key, "fail": f"{e}"[:300], "trace": traceback.format_exc()[-1500:]}


def rows(keys, limit):
    import psycopg2
    db = psycopg2.connect(os.environ["DB_LOCAL_URL"])
    cur = db.cursor()
    cur.execute("""SELECT a.key, a.title, d.sha256, d.raw_key, d.meta FROM acts a JOIN documents d ON d.id = a.document_id
                   WHERE a.key IN (SELECT key FROM docs)
                   UNION ALL
                   SELECT DISTINCT ON (1) 'gazette:' || (d.meta->>'gazette_no'), d.title, d.sha256, d.raw_key, d.meta
                   FROM documents d WHERE d.source = 'gazette' AND d.raw_key IS NOT NULL AND d.meta->>'lang' = 'ENGLISH'
                     AND 'gazette:' || (d.meta->>'gazette_no') IN (SELECT key FROM docs)
                   ORDER BY 1""")
    out = [r for r in cur.fetchall() if keys is None or r[0] in keys]
    db.close()
    return out[:limit] if limit else out


def ident(i):
    return (i["key"], i["check"], i["where"], (i["cause"] or "").split(":")[0])


def summary(res, issues, prev, keys):
    """Per kind; per check (severity, cause); fixed and new against the previous run, on the documents both runs
    checked (`keys`: a full run after a targeted one compares only the targeted documents, 2026-11-08)."""
    lines, by = [], defaultdict(Counter)
    for r in res:
        k = by[r.get("kind", "fail")]
        if "fail" in r:
            k["failed"] += 1
            continue
        for f in ("old_chunks", "new_chunks", "same_text", "dropped_words", "recovered_words"):
            k[f] += r[f]
        k["docs"] += 1
        k["labels_lost"] += len(r["lost"])
        k["labels_gained"] += len(r["gained"])
        k["docs_losing"] += bool(r["lost"])
    for kind, k in sorted(by.items(), key=lambda x: -x[1]["docs"]):
        lines.append(f"== {kind}: {k['docs']} docs, {k['failed']} failed; labels lost {k['labels_lost']} in "
                     f"{k['docs_losing']} docs, gained {k['labels_gained']}; chunks {k['old_chunks']} -> {k['new_chunks']}, "
                     f"today's exact text {100 * k['same_text'] / max(1, k['new_chunks']):.1f}%; words recovered "
                     f"{k['recovered_words']}, dropped on purpose {k['dropped_words']}")
    gl = [r for r in res if "gold" in r]
    if gl:
        lines.append(f"\n== structure gold set ({len(gl)} amending laws, {sum(r['gold']['v2']['own'] for r in gl)} own sections)")
        for who in ("v2", "today"):
            own = sum(r["gold"][who]["own"] for r in gl)
            found = sum(r["gold"][who]["found"] for r in gl)
            extra = sum(len(r["gold"][who]["extra"]) for r in gl)
            qa = sum(len(r["gold"][who]["quoted_as_unit"]) for r in gl)
            lines.append(f"   {who:5}: own sections found {found}/{own} ({100 * found / max(1, own):.1f}%); units that are not "
                         f"own sections {extra} ({qa} of them quoted text); precision {100 * found / max(1, found + extra):.1f}%; "
                         f"laws exactly right {sum(r['gold'][who]['found'] == r['gold'][who]['own'] and not r['gold'][who]['extra'] for r in gl)}/{len(gl)}")
    lines.append("\n== issues by check (severity: count in docs) and cause")
    kinds = {r["key"]: r.get("kind") for r in res}
    per = defaultdict(Counter)
    for i in issues:
        per[(i["check"], i["severity"])][(i["cause"] or "").split(":")[0]] += 1
    for (c, s), causes in sorted(per.items(), key=lambda x: ("error warn accepted info".split().index(x[0][1]), -sum(x[1].values()))):
        docs = len({i["key"] for i in issues if i["check"] == c and i["severity"] == s})
        by_kind = Counter(kinds.get(i["key"]) for i in issues if i["check"] == c and i["severity"] == s)
        top = ", ".join(f"{x} {n}" for x, n in causes.most_common(4)) if len(causes) > 1 else ""
        lines.append(f"   {c} [{s}]: {sum(causes.values())} in {docs} docs ({', '.join(f'{a} {b}' for a, b in by_kind.most_common())})"
                     + (f"; causes: {top}" if top else ""))
    if prev is not None:
        now = {ident(i) for i in issues if i["key"] in keys}
        before = {ident(i) for i in prev if i["key"] in keys}
        fixed, new = Counter(x[1] for x in before - now), Counter(x[1] for x in now - before)
        lines.append(f"\n== against the previous run ({len(keys)} documents both checked): " + (", ".join(
            f"{c} fixed {fixed[c]} new {new[c]}" for c in sorted(set(fixed) | set(new))) or "no change"))
    return "\n".join(lines)


def review(res, issues, top=60):
    """review.md: documents ranked by errors, then warnings; each with its issues (evidence and cause)."""
    by = defaultdict(list)
    for i in issues:
        by[i["key"]].append(i)
    rank = sorted(by, key=lambda k: (-sum(i["severity"] == "error" for i in by[k]), -sum(i["severity"] == "warn" for i in by[k])))
    out = ["# Review list\n", "Documents with errors first (a unit label lost against today), then warnings (likely ours "
           "to fix). Each issue: where, page, cause, the text that shows it.\n"]
    for k in rank[:top]:
        e, w = sum(i["severity"] == "error" for i in by[k]), sum(i["severity"] == "warn" for i in by[k])
        if not (e or w):
            break
        out.append(f"\n## {k}  ({e} errors, {w} warnings)\n")
        for i in sorted(by[k], key=lambda i: "error warn accepted info".split().index(i["severity"]))[:25]:
            if i["severity"] in ("info", "accepted"):
                continue
            ev = (i["evidence"] or "").replace("\n", " ")
            out.append(f"- **{i['check']}** {i['where'] or ''}" + (f" (p{i['page']})" if i["page"] else "")
                       + f": {i['cause']}" + (f" — `{ev[:140]}`" if ev else ""))
    return "\n".join(out) + "\n"


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--keys")
    a.add_argument("--limit", type=int)
    a.add_argument("--workers", type=int, default=16)
    a.add_argument("--diff", action="store_true", help="keep today's and v2's differing chunk texts in the report")
    a.add_argument("--against", help="the run folder to compare with (default: the latest with issues.jsonl)")
    a.add_argument("--summary", help="only rewrite this run folder's summary.txt (with --against), nothing is rebuilt")
    args = a.parse_args()
    if args.summary:
        d = args.summary.rstrip("/")
        res = [json.loads(l) for l in open(f"{d}/report.jsonl")]
        issues = [json.loads(l) for l in open(f"{d}/issues.jsonl")]
        prev = [json.loads(l) for l in open(f"{args.against.rstrip('/')}/issues.jsonl")] if args.against else None
        both = {r["key"] for r in res} & ({json.loads(l)["key"] for l in open(f"{args.against.rstrip('/')}/report.jsonl")}
                                          if args.against else set())
        s = summary(res, issues, prev, both)
        open(f"{d}/summary.txt", "w").write(s + "\n")
        print(s)
        return
    keys = set(args.keys.split(",")) if args.keys else None
    todo = rows(keys, args.limit)
    runs = sorted(glob.glob(f"{RUNS}/*/issues.jsonl"))
    against = args.against and f"{args.against.rstrip('/')}/issues.jsonl" or (runs[-1] if runs else None)
    out = f"{RUNS}/{time.strftime('%Y%m%d_%H%M%S')}"
    os.makedirs(f"{out}/samples", exist_ok=True)
    print(f"{len(todo)} documents -> {out}" + (f" (against {os.path.dirname(against)})" if against else ""), flush=True)
    res, issues, t0 = [], [], time.time()
    with ProcessPoolExecutor(args.workers, initializer=_init, initargs=(args.diff,)) as ex, \
            open(f"{out}/report.jsonl", "w") as f, open(f"{out}/issues.jsonl", "w") as fi:
        for i, r in enumerate(ex.map(one, todo, chunksize=4), 1):
            if "sample" in r:
                json.dump(r.pop("sample"), open(f"{out}/samples/{r['key'].replace('/', '_').replace(':', '_')}.json", "w"),
                          ensure_ascii=False, indent=1)
            for x in r.pop("_issues", []):
                fi.write(json.dumps(x, ensure_ascii=False) + "\n")
                issues.append(x)
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            res.append(r)
            if "fail" in r:
                print(f"FAIL {r['key']}: {r['fail']}", flush=True)
            if i % 500 == 0 or i == len(todo):
                print(f"[{i}/{len(todo)}] {time.time() - t0:.0f}s", flush=True)
    prev = [json.loads(l) for l in open(against)] if against else None
    both = {r["key"] for r in res} & ({json.loads(l)["key"] for l in open(against.replace("issues.jsonl", "report.jsonl"))}
                                      if against else set())
    s = summary(res, issues, prev, both)
    open(f"{out}/summary.txt", "w").write(s + "\n")
    open(f"{out}/review.md", "w").write(review(res, issues))
    print(s, flush=True)


if __name__ == "__main__":
    main()
