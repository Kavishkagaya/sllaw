#!/usr/bin/env python3
"""The v2 pipeline's one entry point (docs/PIPELINE_V2.md). No workflow engine inside: a scheduler, a cron line or
a person runs `plan`, then starts as many `work`ers as it likes, on any host; they share the state database
(V2_DATABASE_URL) and claim items from it (etl/v2/work.py), so none takes another's item and a crashed one's
items come back after its lease.

  python3 -m etl.v2.run init                       # the schema (etl/v2/schema.sql), idempotent
  python3 -m etl.v2.run seed                       # one-off: the v1 inventory (DB_LOCAL_URL) and R2 -> v2 state
  python3 -m etl.v2.run listing <spider>|all [--limit N]   # stage 1 (spider names: etl/v2/stages.py SPIDERS)
  python3 -m etl.v2.run plan  fetch|extract|ocr-ENGLISH|ocr-SINHALA|ocr-TAMIL|build|links    # which items are new or changed (by fingerprint)
  python3 -m etl.v2.run work  fetch|extract|ocr-<LANG>|build|links [--n 4]   # claim and do items until none is left
  python3 -m etl.v2.run resolve                    # links: mentions -> target chunks (one at a time, a lease row)
  python3 -m etl.v2.run choose                     # stage 2's choice of file per document, against today's
  python3 -m etl.v2.run checked [--passed HASH]       # the state's hash and the one the quality gate last passed
  python3 -m etl.v2.run checked [--passed HASH]    # the state's hash, and the one the quality gate last passed
  python3 -m etl.v2.run publish|embed [--apply]    # stages 7-8: what changed downstream (a dry run without --apply)
  python3 -m etl.v2.run status

Stages 1-3 are etl/v2/stages.py (today's spiders, downloader and engines with the v2 rules); `seed` brings what
today's pipeline already fetched and extracted into the v2 state, so nothing is fetched or extracted again.
"""
import argparse, hashlib, json, os, re, sys, time, traceback

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import Json, execute_values

from etl.v2 import build as B, work as W

load_dotenv(os.path.expanduser("~/sllaw/.env"))
HERE = os.path.dirname(__file__)


def db():
    return psycopg2.connect(os.environ["V2_DATABASE_URL"])


def init():
    with db() as c, c.cursor() as cur:
        cur.execute(open(os.path.join(HERE, "schema.sql")).read())
    print("schema applied")


# -- seed: today's inventory as v2 state ------------------------------------------------------------------------------

SOURCES = {"acts": ("documents.gov.lk", "acts"), "gazette": ("documents.gov.lk", "gazettes"),
           "parliament": ("parliament.lk", "acts"), "constitution": ("parliament.lk", "constitution"),
           "lankalaw": ("lankalaw", "acts-by-year"), "le1980": ("lankalaw", "le1980"), "le1956": ("lankalaw", "le1956"),
           "commonlii": ("commonlii", "numbered-acts")}


def v1_type(source, meta):
    """A v1 listing -> (type, listed_key): what the listing says the document is (docs/PIPELINE_V2.md, types)."""
    no = meta.get("act_no") or ""
    if meta.get("constitution"):
        k = meta["constitution"]
        return ("constitution" if k == "constitution" else "constitution_consolidation"), k
    if meta.get("cap"):
        return "revised_1980", f"cap:{meta['cap']}"
    if meta.get("cap1956"):
        return "revised_1956", f"cap1956:{meta['cap1956']}"
    if source == "gazette":
        return "gazette", f"gazette:{meta.get('gazette_no')}"
    if re.fullmatch(r"0/\d{4}", no):
        # documents.gov.lk lists amendments as 0/YYYY; the ordinal is in the title ("18th Amendment", "Twenty Second")
        return "constitution_amendment", (f"amendment:{n}" if (n := ordinal(meta.get("listing", {}).get("descriptionEnglish")
                                                                          or meta.get("title") or "")) else None)
    kind = meta.get("kind") if meta.get("kind") in ("law", "ordinance") else "act"
    if kind == "act" and re.fullmatch(r"\d+/\d{4}", no) and 1973 <= int(no[-4:]) <= 1977:
        kind = "law"
    return kind, (f"{kind}:{int(no.split('/')[0])}/{no.split('/')[1]}" if re.fullmatch(r"\d+/\d{4}", no) else None)


WORDS = {w: i for i, w in enumerate("first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth "
                                    "thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth".split(), 1)}


def ordinal(t):
    """'18th Amendment to the Constitution' -> 18, 'Twenty Second Amendment' -> 22, None if none."""
    if (m := re.search(r"\b(\d{1,2})\s*(?:st|nd|rd|th)\b", t, re.I)):
        return int(m[1])
    w = re.findall(r"[a-z]+", t.lower())
    for i, x in enumerate(w):
        if x in WORDS:
            return WORDS[x] + (20 if i and w[i - 1] == "twenty" else 30 if i and w[i - 1] == "thirty" else 0)
        if x in ("twentieth", "thirtieth"):
            return 20 if x == "twentieth" else 30
    return None


def seed():
    old = psycopg2.connect(os.environ["DB_LOCAL_URL"])
    new = db()
    s3, bucket = B.r2()
    lighton = set()
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="raw/lighton/"):
        lighton |= {o["Key"][len("raw/lighton/"):-len(".json.gz")] for o in page.get("Contents", [])}
    with old.cursor() as o, new.cursor() as n:
        o.execute("SELECT id, source, source_url, title, doc_date, meta, sha256, r2_key, raw_key, fetched_at FROM documents")
        rows = o.fetchall()
        listing = []
        for i, src, url, title, date, meta, sha, r2k, raw, fetched in rows:
            source, spider = SOURCES.get(src, (src, src))
            typ, lk = v1_type(src, meta)
            fmt = "html" if (meta.get("format") == "html" or (r2k or "").endswith(".html")) else "pdf"
            listing.append((source, spider, url, typ, lk, title, date, meta.get("date_precision") or "day",
                            meta.get("lang"), fmt, Json({**meta.get("listing", {}), "v1_id": i, "v1_meta": meta})))
        execute_values(n, """INSERT INTO listings (source, spider, source_url, type, listed_key, title, date, date_precision,
                               language, format, listing) VALUES %s
                             ON CONFLICT (source, source_url) DO UPDATE SET listing = EXCLUDED.listing, type = EXCLUDED.type,
                               listed_key = EXCLUDED.listed_key, last_seen = NOW()""",
                       listing, page_size=2000)
        n.execute("SELECT id, (listing->>'v1_id')::int FROM listings")
        lid = {v1: i for i, v1 in n.fetchall()}
        files = {}
        for i, src, url, title, date, meta, sha, r2k, raw, fetched in rows:
            if sha and r2k:
                files[sha] = (sha, r2k.rsplit(".", 1)[-1], None, None, r2k, raw, sha in lighton)
        execute_values(n, """INSERT INTO files (sha256, ext, bytes, content_type, r2_key, raw_key, lighton) VALUES %s
                             ON CONFLICT (sha256) DO UPDATE SET raw_key = EXCLUDED.raw_key, lighton = EXCLUDED.lighton""",
                       list(files.values()), page_size=2000)
        execute_values(n, """INSERT INTO listing_files (listing_id, sha256, fetched_from, fetched_at) VALUES %s
                             ON CONFLICT (listing_id) DO UPDATE SET sha256 = EXCLUDED.sha256""",
                       [(lid[i], sha, url, fetched) for i, src, url, title, date, meta, sha, r2k, raw, fetched in rows
                        if sha and r2k and i in lid], page_size=2000)
        # today's choice of file per document: the acts list (laws) and one file per gazette number
        o.execute("""SELECT a.key, a.title, a.document_id FROM acts a WHERE a.key IN (SELECT key FROM docs)
                     UNION ALL
                     SELECT DISTINCT ON (1) 'gazette:' || (meta->>'gazette_no'), title, id FROM documents
                     WHERE source = 'gazette' AND raw_key IS NOT NULL AND meta->>'lang' = 'ENGLISH'
                       AND 'gazette:' || (meta->>'gazette_no') IN (SELECT key FROM docs) ORDER BY 1, 3""")
        chosen = o.fetchall()
        by_id = {r[0]: r for r in rows}
        docs = []
        for key, title, doc_id in chosen:
            r = by_id[doc_id]
            typ, _ = v1_type(r[1], r[5])
            docs.append((key, typ, title, lid[doc_id], r[6], r[5].get("lang"), "v1"))
        execute_values(n, """INSERT INTO documents (key, type, title, listing_id, sha256, language, chosen_by) VALUES %s
                             ON CONFLICT (key) DO UPDATE SET listing_id = EXCLUDED.listing_id, sha256 = EXCLUDED.sha256,
                               title = EXCLUDED.title, updated_at = NOW()""", docs, page_size=2000)
        o.execute("SELECT src_doc, dst_doc FROM links WHERE kind = 'same_as'")
        execute_values(n, "INSERT INTO same_as (a, b) VALUES %s ON CONFLICT DO NOTHING",
                       list({tuple(x) for x in o.fetchall()}), page_size=5000)
    new.commit()
    print(f"seeded: {len(listing)} listings, {len(files)} files, {len(docs)} documents, LightOn pages for {len(lighton)} files")


# -- stage 2's choice, checked against today's -----------------------------------------------------------------------

RANK = {"act": ["documents.gov.lk", "parliament.lk", "lankalaw", "commonlii"],
        "law": ["parliament.lk", "lankalaw", "commonlii"],
        "constitution_amendment": ["documents.gov.lk", "parliament.lk"],
        "revised_1980": ["lankalaw", "commonlii"]}
LANG = ["ENGLISH", "SINHALA", "TAMIL"]


def overrides():
    p = os.path.join(HERE, "..", "overrides.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def choose():
    """For every listed key: the file stage 2 would pick (language, then source rank; pins, rejects, rekeys from
    etl/overrides.json), against the file today's build uses. Read-only: prints where they differ."""
    ov = overrides()
    reject = {r["listing"] for r in ov.get("reject", [])}
    rekey = {r["listing"]: r["key"] for r in ov.get("rekey", [])}
    pin = {r["key"]: r["listing"] for r in ov.get("pin", [])}
    with db() as c, c.cursor() as cur:
        cur.execute("""SELECT l.id, l.source, l.type, l.listed_key, l.language, l.source_url, lf.sha256, f.raw_key
                       FROM listings l LEFT JOIN listing_files lf ON lf.listing_id = l.id LEFT JOIN files f ON f.sha256 = lf.sha256""")
        cand = {}
        for lid, source, typ, key, lang, url, sha, raw in cur.fetchall():
            key = rekey.get(url, key)
            if key and url not in reject:
                cand.setdefault(key, []).append((lid, source, typ, lang, url, sha, raw))
        cur.execute("SELECT key, listing_id, sha256 FROM documents")
        today = {k: (lid, sha) for k, lid, sha in cur.fetchall()}
    differ, same, only_new = [], 0, 0
    for key, cs in cand.items():
        if key in pin:
            pick = next((c for c in cs if c[4] == pin[key]), None)
        else:
            rank = RANK.get(cs[0][2], [])
            usable = [c for c in cs if c[5] and c[6]] or cs           # a file held and extracted first
            pick = min(usable, key=lambda c: (LANG.index(c[3]) if c[3] in LANG else 9,
                                              rank.index(c[1]) if c[1] in rank else 9, c[0]))
        if key not in today:
            only_new += 1
        elif pick and (pick[0] == today[key][0] or pick[5] == today[key][1]):
            same += 1
        else:
            differ.append((key, pick and pick[1], pick and pick[4], today[key]))
    print(f"documents today {len(today)}; stage 2 picks the same file for {same}, a different one for {len(differ)}; "
          f"{only_new} keys are listed but not built today (other languages, other types, files not held)")
    for d in differ[:40]:
        print("  differs:", d)


# -- stage 4-5: build -------------------------------------------------------------------------------------------------

def plan_build(keys=None):
    ov = overrides()
    fixes = {}
    for kind in ("pin", "reject", "rekey", "accept"):
        for r in ov.get(kind, []):
            if r.get("key"):
                fixes.setdefault(r["key"], []).append([kind, r.get("where") or r.get("listing"), r.get("reason")])
    with db() as c, c.cursor() as cur:
        cur.execute("""SELECT d.key, d.title, f.sha256, f.lighton, f.ocr_engine FROM documents d JOIN files f ON f.sha256 = d.sha256
                       WHERE f.raw_key IS NOT NULL""")
        items = []
        for key, title, sha, lo, oe in cur.fetchall():
            lo = f"{lo}|{oe}" if oe else lo          # a raw re-read with OCR is a new input
            if keys and key not in keys:
                continue
            from etl.v2.profiles import profile
            items.append((key, B.fingerprint(sha, lo, profile(key, title), fixes.get(key))))
        changed, same = W.plan(c, "build", items)
    print(f"build: {changed} newly queued, {same} already queued or built with this code")


def do_build(c, key, fp=None):
    with c.cursor() as cur:
        cur.execute("""SELECT d.title, f.sha256, f.raw_key, f.lighton, l.listing->'v1_meta', l.date, l.date_precision
                       FROM documents d JOIN files f ON f.sha256 = d.sha256 JOIN listings l ON l.id = d.listing_id
                       WHERE d.key = %s""", (key,))
        title, sha, raw_key, lo, meta, listed, precision = cur.fetchone()
    c.commit()
    raw = B.get_json(raw_key)
    lighton = B.get_json(f"raw/lighton/{sha}.json.gz") if lo else None
    prof, engine, paras, st, tree, info, ch, issues = B.build_doc(key, title, raw, lighton, meta or {})
    from etl.docs import long_title_of
    from etl.v2.dates import dates
    return B.store(c, key, title, sha, prof, tree, ch, issues, fp,
                   {"long_title": long_title_of(paras), **dates(key, ch, listed, precision, paras)})


# -- stage 6: links (mentions out of each document; resolution inside the database) -----------------------------------

def load_names(cur):
    """The name indexes etl.refs uses, from v2's own tables: 1980 chapters by title, principal laws by title."""
    from etl import graph, refs
    cur.execute("SELECT key, title FROM docs WHERE key LIKE 'cap:%%'")
    seen = {}
    for k, t in cur.fetchall():
        if (n := graph.norm_name(t or "")):
            seen.setdefault(n, set()).add(k)
    graph.CHAPTERS.clear()
    graph.CHAPTERS.update({n: next(iter(ks)) for n, ks in seen.items() if len(ks) == 1})
    cur.execute("SELECT key, title FROM docs WHERE key ~ '^(act|law):' AND title !~* 'amendment|appropriation'")
    seen = {}
    for k, t in cur.fetchall():
        if (n := graph.norm_name(re.sub(r",?\s*No\.?\s*\d+\s+of\s+\d{4}.*$", "", t or "", flags=re.I))):
            seen.setdefault(n, set()).add(k)
    graph.TITLES.clear()
    graph.TITLES.update({n: next(iter(ks)) for n, ks in seen.items() if len(ks) == 1})
    refs.load_names(cur)


def refs_version():
    """The link readers' code: etl/refs.py (patterns) and etl/mentions.py (mentions); a change relinks everything."""
    h = hashlib.sha1()
    for f in ("refs.py", "mentions.py"):
        h.update(open(os.path.join(HERE, "..", f), "rb").read())
    return h.hexdigest()[:12]


def plan_links(keys=None):
    with db() as c, c.cursor() as cur:
        cur.execute("""SELECT d.key, string_agg(c.text_hash, ',' ORDER BY c.seq) FROM docs d JOIN chunks c ON c.doc_key = d.key
                       GROUP BY d.key""")
        rv = refs_version()
        items = [(k, hashlib.sha1(f"{h}|{rv}".encode()).hexdigest()) for k, h in cur.fetchall() if not keys or k in keys]
        changed, same = W.plan(c, "links", items)
    print(f"links: {changed} newly queued, {same} already queued or read")


def do_links(c, key, fp=None):
    """A document's mentions (etl/mentions.py, docs/LINKS.md): every citation in its chunk text, one row per span,
    replacing the ones it had. Which chunk each provision is, is `resolve`'s job."""
    from etl import mentions as M
    with c.cursor() as cur:
        cur.execute("SELECT parts, meta->>'long_title' FROM docs WHERE key = %s", (key,))
        parts, lt = cur.fetchone()
    text = {}
    for p in parts or []:
        for ch in B.get_json(p)["chunks"]:
            text[ch["id"]] = ch["text"]
    rv = refs_version()
    with c.cursor() as cur:
        cur.execute("SELECT id::text FROM chunks WHERE doc_key = %s ORDER BY seq", (key,))
        ids = [r[0] for r in cur.fetchall()]
        texts = [text.get(i, "") for i in ids]
        rows = []
        for r in M.mentions(key, lt, texts):
            labs = r["labels"] or []
            rows.append((key, None if r["i"] is None else ids[r["i"]], M.kind_of(r), r["dst_doc"], r["dst_name"],
                         labs[0] if len(labs) == 1 else None, (r["context"] or "")[:300] or None,
                         Json({"via": r["via"], **({"ops": r["ops"]} if r["ops"] else {})}),
                         r["start"], r["end"], (r["span"] or "")[:300], r["relation"], r["scope"], r["law_form"],
                         (r["law_text"] or "")[:200] or None, r["dst_type"], r["unit"], labs, r["sub"], r["in_quote"],
                         r["confidence"], r["via"], Json(r["ops"]) if r["ops"] else None, rv))
        cur.execute("DELETE FROM mentions WHERE src_doc = %s", (key,))
        if rows:
            execute_values(cur, """INSERT INTO mentions (src_doc, src_chunk, kind, dst_doc, dst_name, dst_label, context, detail,
                                   start_at, end_at, span, relation, scope, law_form, law_text, dst_type, unit, labels, sub,
                                   in_quote, confidence, via, ops, refs_version) VALUES %s""", rows, page_size=1000)
    c.commit()
    return {"mentions": len(rows), "unidentified": sum(1 for r in rows if r[3] is None)}


def resolve():
    """Mentions -> links (resolved edges only), in the database: each provision a mention names -> the first chunk
    with that label in the cited law or a same_as twin; a whole-law citation -> the law; a repealed Part/Chapter -> one
    link per section under it. Then each mention's status says what did not resolve. One worker at a time (a lease
    row); everything is recomputed in SQL (no text read)."""
    with db() as c:
        if not W.singleton(c, "resolve"):
            print("another worker is resolving")
            return
        with c.cursor() as cur:
            cur.execute("TRUNCATE links")
            cur.execute("""CREATE TEMP TABLE alias AS SELECT a, b FROM same_as UNION SELECT b, a FROM same_as""")
            cur.execute("CREATE INDEX ON alias (a)")
            # one row per provision named (a whole-law citation: one row, label null)
            cur.execute("""CREATE TEMP TABLE tg AS
                           SELECT m.id, m.src_doc, m.src_chunk, m.kind, m.dst_doc, t.label
                           FROM mentions m CROSS JOIN LATERAL unnest(CASE WHEN cardinality(m.labels) > 0 THEN m.labels
                                                                         ELSE ARRAY[NULL::text] END) t(label)
                           WHERE m.dst_doc IS NOT NULL""")
            # the documents each one may be in: the law cited first, then its same_as twins (joins, not an OR, so
            # the (doc_key, label) index is used: the OR form ran over 6 minutes, 2026-11-09)
            cur.execute("""CREATE TEMP TABLE cand AS
                           SELECT tg.id, tg.label, tg.dst_doc doc, 0 pref FROM tg
                           UNION ALL SELECT tg.id, tg.label, x.b, 1 FROM tg JOIN alias x ON x.a = tg.dst_doc""")
            cur.execute("ANALYZE tg; ANALYZE cand")
            cur.execute("""INSERT INTO links (mention_id, src_doc, src_chunk, kind, dst_doc, dst_label, dst_chunk, via_alias)
                           SELECT DISTINCT ON (tg.id, tg.label) tg.id, tg.src_doc, tg.src_chunk, tg.kind, c.doc_key,
                                  tg.label, c.id, c.doc_key <> tg.dst_doc
                           FROM tg JOIN cand k ON k.id = tg.id AND k.label = tg.label
                           JOIN chunks c ON c.doc_key = k.doc AND c.label = tg.label
                           WHERE tg.label IS NOT NULL
                           ORDER BY tg.id, tg.label, k.pref, c.seq""")
            cur.execute("""INSERT INTO links (mention_id, src_doc, src_chunk, kind, dst_doc, dst_label, dst_chunk, via_alias)
                           SELECT DISTINCT ON (tg.id) tg.id, tg.src_doc, tg.src_chunk, tg.kind, d.key, NULL, NULL, d.key <> tg.dst_doc
                           FROM tg JOIN cand k ON k.id = tg.id AND k.label IS NULL JOIN docs d ON d.key = k.doc
                           WHERE tg.label IS NULL
                           ORDER BY tg.id, k.pref, d.key""")
            # a repealed Part or Chapter: one link per section under it, from the target, else the first same_as twin
            # that has that Part (addresses are key/scope/label/..., so the scope is in the address)
            cur.execute("""INSERT INTO links (mention_id, src_doc, src_chunk, kind, dst_doc, dst_label, dst_chunk, part, via_alias)
                           WITH m AS (SELECT id, src_doc, src_chunk, kind, dst_doc, label FROM tg
                                      WHERE kind = 'repeals' AND label ~ '^(Part|Chapter) [IVXL]+[A-Z]?$'),
                           hit AS (SELECT m.id, x.doc, x.pref, c.label, c.id chunk, c.seq FROM m
                                   CROSS JOIN LATERAL (SELECT m.dst_doc doc, 0 pref UNION ALL
                                                       SELECT b, 1 FROM alias WHERE a = m.dst_doc) x
                                   JOIN chunks c ON c.doc_key = x.doc AND c.label IS NOT NULL AND c.kind = 'unit'
                                                AND c.address LIKE x.doc || '/' || m.label || '/%%'),
                           best AS (SELECT DISTINCT ON (id) id, doc FROM hit ORDER BY id, pref, doc),
                           one AS (SELECT DISTINCT ON (h.id, h.label) h.id, h.doc, h.label, h.chunk
                                   FROM best b JOIN hit h ON h.id = b.id AND h.doc = b.doc ORDER BY h.id, h.label, h.seq)
                           SELECT DISTINCT ON (one.id, one.label) one.id, m.src_doc, m.src_chunk, m.kind, one.doc, one.label,
                                  one.chunk, m.label, one.doc <> m.dst_doc
                           FROM one JOIN m ON m.id = one.id ORDER BY one.id, one.label""")
            # each mention: what resolved, what did not and why
            cur.execute("""CREATE TEMP TABLE lk AS SELECT DISTINCT mention_id, coalesce(part, dst_label) lab FROM links""")
            cur.execute("""CREATE TEMP TABLE ins AS SELECT DISTINCT k.doc, k.label lab FROM tg JOIN cand k ON k.id = tg.id
                           AND k.label IS NOT DISTINCT FROM tg.label WHERE tg.kind = 'inserts' AND tg.label IS NOT NULL""")
            cur.execute("""CREATE TEMP TABLE heldk AS SELECT DISTINCT tg.dst_doc doc FROM tg JOIN cand k ON k.id = tg.id
                           JOIN docs d ON d.key = k.doc""")
            cur.execute("""CREATE INDEX ON lk (mention_id); CREATE INDEX ON ins (doc, lab); CREATE INDEX ON heldk (doc);
                           ANALYZE lk; ANALYZE ins; ANALYZE heldk""")
            cur.execute("""WITH per AS (SELECT m.id, m.dst_doc, count(*) n, count(lk.mention_id) ok,
                                          array_agg(t.lab) FILTER (WHERE lk.mention_id IS NULL AND t.lab IS NOT NULL) unres,
                                          bool_and(lk.mention_id IS NOT NULL OR EXISTS (SELECT 1 FROM ins
                                                   WHERE ins.doc = m.dst_doc AND ins.lab = t.lab)) all_ins
                                   FROM mentions m CROSS JOIN LATERAL unnest(CASE WHEN cardinality(m.labels) > 0 THEN m.labels
                                                                                 ELSE ARRAY[NULL::text] END) t(lab)
                                   LEFT JOIN lk ON lk.mention_id = m.id AND lk.lab IS NOT DISTINCT FROM t.lab
                                   GROUP BY m.id, m.dst_doc)
                           UPDATE mentions m SET
                             status = CASE WHEN p.dst_doc IS NULL THEN 'unidentified'
                                           WHEN p.ok = p.n THEN 'resolved'
                                           WHEN NOT EXISTS (SELECT 1 FROM heldk h WHERE h.doc = p.dst_doc) THEN 'not_held'
                                           WHEN p.ok > 0 THEN 'partial'
                                           WHEN p.all_ins THEN 'inserted'
                                           ELSE 'label_not_found' END,
                             unresolved = CASE WHEN p.ok = p.n THEN NULL ELSE p.unres END
                           FROM per p WHERE p.id = m.id""")
            cur.execute("SELECT status, count(*) FROM mentions GROUP BY 1 ORDER BY 2 DESC")
            st = cur.fetchall()
            cur.execute("SELECT count(*), count(*) FILTER (WHERE part IS NOT NULL), count(*) FILTER (WHERE dst_doc = src_doc) FROM links")
            print("mentions:", st, "| links: %d (from repealed Parts/Chapters %d, same-law %d)" % cur.fetchone())
        c.commit()
        W.release(c, "resolve")


def gold_links():
    """The 210 hand-labelled links (etl/gold_links.json) against v2's mentions (and same_as pairs): each one's
    right target and section is there, and a wrong target it once had is gone. As `etl.docs gold` does for v1."""
    g = json.load(open(os.path.join(HERE, "..", "gold_links.json")))
    n, bad = {}, []
    with db() as c, c.cursor() as cur:
        def has(src, kind, dst, label):
            """A mention of src (of that kind, or any kind when None) citing one of dst at label (None: whole law)."""
            lab = [label] if label else []
            cur.execute("""SELECT 1 FROM mentions WHERE src_doc = %s AND (%s IS NULL OR kind = %s) AND dst_doc = ANY(%s)
                           AND labels @> %s::text[] AND (%s OR cardinality(labels) = 0)
                           UNION ALL SELECT 1 FROM links WHERE src_doc = %s AND (%s IS NULL OR kind = %s)
                           AND dst_doc = ANY(%s) AND dst_label = %s AND part IS NOT NULL""",
                        (src, kind, kind, dst, lab, bool(lab), src, kind, kind, dst, label))
            return cur.fetchone() is not None

        for x in g:
            if x["kind"] == "same_as":
                cur.execute("SELECT 1 FROM same_as WHERE (a = %s AND b = ANY(%s)) OR (b = %s AND a = ANY(%s))",
                            (x["src"], x["dst"], x["src"], x["dst"]))
                ok = cur.fetchone() is not None
            else:
                ok = has(x["src"], x["kind"], x["dst"], x["label"])
                # a "cites" the old reader wrote beside the change link of the same provision is that one mention now;
                # a whole-law "cites" beside a provision of that law ("Article 79 of the Constitution") is that provision's
                if not ok and x["kind"] == "cites":
                    cur.execute("SELECT 1 FROM mentions WHERE src_doc = %s AND dst_doc = ANY(%s) AND (%s OR labels @> %s::text[])",
                                (x["src"], x["dst"], x["label"] is None, [x["label"]] if x["label"] else []))
                    ok = cur.fetchone() is not None
                if ok and x.get("was"):
                    ok = not has(x["src"], x["kind"], [x["was"][0]], x["was"][1])
            t = n.setdefault(x["kind"], [0, 0])
            t[0] += ok
            t[1] += 1
            if not ok:
                bad.append(x)
    for k, (ok, all_) in sorted(n.items()):
        print(f"{k:13} {ok}/{all_}")
    print(f"total {sum(v[0] for v in n.values())}/{sum(v[1] for v in n.values())}")
    for x in bad:
        print("MISS", x["src"], x["kind"], x["dst"], x["label"], "|", (x.get("note") or x.get("context") or "")[:120])


# -- the worker loop ----------------------------------------------------------------------------------------------------

def plan_fetch(keys=None):
    from etl.v2 import stages
    with db() as c:
        need = [(k, it) for k, it in stages.choose(c) if not keys or k in keys]
        changed, same = W.plan(c, "fetch", [(it, it) for _, it in need])
    print(f"fetch: {len(need)} documents need a file; {changed} new to download, {same} already planned")


def plan_extract(keys=None):
    from etl import extract as X
    with db() as c, c.cursor() as cur:
        cur.execute("""SELECT DISTINCT f.sha256 FROM documents d JOIN files f ON f.sha256 = d.sha256
                       WHERE f.raw_key IS NULL AND (%s::text[] IS NULL OR d.key = ANY(%s))""", (keys and list(keys), keys and list(keys)))
        items = [(sha, f"{sha}|{X.VERSION}") for sha, in cur.fetchall()]
        changed, same = W.plan(c, "extract", items)
    print(f"extract: {changed} files to read, {same} unchanged")


def plan_ocr(keys=None, lang="ENGLISH"):
    """Scans extract left for OCR in one language (stage `ocr-<LANGUAGE>`: one queue per model, since one server
    serves one model)."""
    from etl.v2 import stages
    prof = stages.OCR_MODELS[lang]
    model = os.path.basename(prof["model"]) if prof.get("model") else prof["engine"]   # a new engine re-queues
    with db() as c, c.cursor() as cur:
        cur.execute("SELECT sha256 FROM files WHERE ocr_pages > 0 AND NOT lighton AND coalesce(ocr_lang, 'ENGLISH') = %s",
                    (lang,))
        items = [(sha, f"{sha}|{model}") for sha, in cur.fetchall()]
        changed, same = W.plan(c, f"ocr-{lang}", items)
    print(f"ocr-{lang}: {changed} newly queued, {same} already queued or read")


def do_ocr(c, sha, fp=None):
    from etl.v2 import stages
    return stages.ocr_one(c, sha)


def do_fetch(c, item, fp=None):
    from etl.v2 import stages
    return stages.fetch_one(c, item)


def do_extract(c, sha, fp=None):
    from etl.v2 import stages
    return stages.extract_one(c, sha)


def listing(name, limit=None):
    from etl.v2 import stages
    with db() as c:
        for n in (stages.SPIDERS if name == "all" else [name]):
            try:                       # one site down must not stop the others; its old listing stays as it was
                print(n, stages.listing(c, n, limit), flush=True)
            except Exception as e:
                c.rollback()
                print(n, "FAILED", repr(e)[:300], flush=True)


DO = {"build": do_build, "links": do_links, "fetch": do_fetch, "extract": do_extract,
      **{f"ocr-{l}": do_ocr for l in ("ENGLISH", "SINHALA", "TAMIL")}}
PLAN = {"build": plan_build, "links": plan_links, "fetch": plan_fetch, "extract": plan_extract,
        **{f"ocr-{l}": (lambda keys=None, l=l: plan_ocr(keys, l)) for l in ("ENGLISH", "SINHALA", "TAMIL")}}


ITEM_LIMIT = int(os.environ.get("V2_ITEM_SECONDS", 3600))   # one item past this fails, not retried (2026-11-08:
                                                             # gazette:1960/02, 6 MB of Sinhala tariff tables, ran 30+ min)


class ItemTimeout(Exception):
    pass


def work(stage, n=1, limit=None):
    import signal, threading
    c, done, t0 = db(), 0, time.time()
    current = {}

    def heartbeat():                 # renew the lease of the item in hand every 5 minutes, on a connection of its own
        hb = db()
        while True:
            time.sleep(300)
            if current:
                try:
                    W.renew(hb, stage, current["item"])
                except Exception:
                    hb = db()
    threading.Thread(target=heartbeat, daemon=True).start()

    def too_long(*_):
        raise ItemTimeout(f"over {ITEM_LIMIT}s")
    signal.signal(signal.SIGALRM, too_long)
    if stage == "links":
        with c.cursor() as cur:
            load_names(cur)
        c.commit()
    while True:
        got = W.claim(c, stage, n)
        if not got:
            break
        for item, fp in got:
            t1 = time.time()
            current["item"] = item
            signal.alarm(ITEM_LIMIT)
            try:
                out = DO[stage](c, item, fp)
                signal.alarm(0)
                W.finish(c, stage, item, fp, out)
                if stage not in ("build", "links"):   # slow items: one line each (fast stages: every 100)
                    print(f"{stage} {item[:16]} {time.time() - t1:.0f}s {json.dumps(out, ensure_ascii=False)[:160]}", flush=True)
            except Exception as e:
                signal.alarm(0)
                c.rollback()
                W.fail(c, stage, item, f"{e}\n{traceback.format_exc()[-1500:]}")
                if isinstance(e, ItemTimeout):         # a retry would take as long again: no more tries
                    with c.cursor() as cur:
                        cur.execute("UPDATE work SET tries = %s WHERE stage = %s AND item = %s", (W.MAX_TRIES, stage, item))
                    c.commit()
                print(f"FAIL {stage} {item}: {str(e)[:300]}", flush=True)
            current.clear()
            done += 1
            if done % 100 == 0:
                print(f"{stage}: {done} done by this worker, {time.time() - t0:.0f}s", flush=True)
        if limit and done >= limit:
            break
    print(f"{stage}: {done} items in {time.time() - t0:.0f}s", flush=True)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("cmd", choices=["init", "seed", "listing", "plan", "work", "resolve", "choose", "publish", "embed", "gold-links", "status", "checked"])
    a.add_argument("--apply", action="store_true", help="publish/embed: write (default: say what would change)")
    a.add_argument("--prune-v1", action="store_true", help="embed: also delete v1's vectors (after the app reads v2)")
    a.add_argument("--passed", help="checked: record that the quality gate passed this state hash")
    a.add_argument("stage", nargs="?")
    a.add_argument("--n", type=int, default=2)
    a.add_argument("--limit", type=int)
    a.add_argument("--keys")
    x = a.parse_args()
    keys = set(x.keys.split(",")) if x.keys else None
    if x.cmd == "init":
        init()
    elif x.cmd == "seed":
        seed()
    elif x.cmd == "choose":
        choose()
    elif x.cmd in ("publish", "embed"):
        from etl.v2 import downstream
        with db() as c:
            print(x.cmd, ("" if x.apply else "(dry run) "), getattr(downstream, x.cmd)(c, apply=x.apply, **({"prune_v1": x.prune_v1} if x.cmd == "embed" else {})))
    elif x.cmd == "checked":
        from etl.v2 import downstream
        with db() as c:
            print("checked", json.dumps(downstream.checked(c, x.passed)))
    elif x.cmd == "gold-links":
        gold_links()
    elif x.cmd == "listing":
        listing(x.stage or "all", x.limit)
    elif x.cmd == "resolve":
        resolve()
    elif x.cmd == "plan":
        PLAN[x.stage](keys)
    elif x.cmd == "work":
        work(x.stage, x.n, x.limit)
    else:
        with db() as c:
            for row in W.status(c, x.stage):
                print(*row)


if __name__ == "__main__":
    main()
