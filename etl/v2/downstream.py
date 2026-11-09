"""Stages 7-8 (docs/PIPELINE_V2.md): send what changed, delete what disappeared. Both are dry runs unless told
otherwise, because they change what the app sees (kb.*, the search index).

  publish   per document whose build fingerprint or links changed since it was last published (table `published`):
            its rows are replaced in the schema `kb` of this same database (kb.docs, kb.chunks, kb.links), all
            documents in one transaction run inside Postgres, so nothing leaves the database and the app sees a
            whole release or none of it. The app reads only `kb` (decision 2026-11-08: no separate app copy of the
            corpus; the pipeline's own tables change during a run, kb only after the quality gate). No chunk text
            in the database: kb.docs.parts names the R2 text parts (decision 2026-11-07).
  embed     per chunk: same id and text hash in the index -> nothing; else embed (bge-m3). Ids gone -> deleted.
            Reads kb (what the app sees). Target: the live Zilliz collection `chunks` (Int64 id = vid(uuid), see below).
"""
import hashlib, json, os

from psycopg2.extras import execute_values

from etl.v2 import build as B

# kb: what the app reads (app/packages/etl_db). A chunk's id is its vid (an Int64 under 2**53, so a JS number; the
# same id as in Zilliz); its uuid stays beside it. A link's chunks are vids too. Dates come from the build
# (etl/v2/dates.py, in docs.meta); a link is dated by its source law's commencement, as v1 did (etl/docs.py).
KB_SCHEMA = """
CREATE SCHEMA IF NOT EXISTS kb;
CREATE TABLE IF NOT EXISTS kb.docs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, year INT, certified DATE,
    commenced DATE, commencement JSONB, long_title TEXT, source_url TEXT, parts TEXT[] NOT NULL, meta JSONB,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS kb.chunks (id BIGINT PRIMARY KEY, uuid UUID NOT NULL UNIQUE,
    doc_key TEXT NOT NULL REFERENCES kb.docs(key) ON DELETE CASCADE, address TEXT NOT NULL UNIQUE, seq INT NOT NULL,
    label TEXT, kind TEXT, path TEXT, part INT NOT NULL, text_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS kb_chunks_doc_idx ON kb.chunks (doc_key, seq);
CREATE INDEX IF NOT EXISTS kb_chunks_label_idx ON kb.chunks (doc_key, label);
CREATE TABLE IF NOT EXISTS kb.links (id BIGSERIAL PRIMARY KEY, src_doc TEXT NOT NULL REFERENCES kb.docs(key) ON DELETE CASCADE,
    src_chunk BIGINT, kind TEXT NOT NULL, dst_doc TEXT NOT NULL, dst_label TEXT, dst_chunk BIGINT, status TEXT, date DATE,
    context TEXT, detail JSONB);
CREATE INDEX IF NOT EXISTS kb_links_src_idx ON kb.links (src_doc);
CREATE INDEX IF NOT EXISTS kb_links_src_chunk_idx ON kb.links (src_chunk);
CREATE INDEX IF NOT EXISTS kb_links_dst_idx ON kb.links (dst_doc, dst_label);
CREATE INDEX IF NOT EXISTS kb_links_dst_chunk_idx ON kb.links (dst_chunk);
-- docs/LINKS.md (2026-11-09): kb.links holds resolved links only (one source, one destination); the citation each
-- comes from is in kb.mentions (every citation as read, resolved or not, with why not)
ALTER TABLE kb.links ADD COLUMN IF NOT EXISTS mention_id BIGINT, ADD COLUMN IF NOT EXISTS relation TEXT,
    ADD COLUMN IF NOT EXISTS scope TEXT, ADD COLUMN IF NOT EXISTS law_form TEXT, ADD COLUMN IF NOT EXISTS confidence TEXT,
    ADD COLUMN IF NOT EXISTS in_quote BOOLEAN, ADD COLUMN IF NOT EXISTS span TEXT, ADD COLUMN IF NOT EXISTS span_start INT,
    ADD COLUMN IF NOT EXISTS span_end INT, ADD COLUMN IF NOT EXISTS sub TEXT, ADD COLUMN IF NOT EXISTS dst_type TEXT,
    ADD COLUMN IF NOT EXISTS part TEXT, ADD COLUMN IF NOT EXISTS via_alias BOOLEAN;
CREATE INDEX IF NOT EXISTS kb_links_mention_idx ON kb.links (mention_id);
CREATE TABLE IF NOT EXISTS kb.mentions (id BIGINT PRIMARY KEY, src_doc TEXT NOT NULL REFERENCES kb.docs(key) ON DELETE CASCADE,
    src_chunk BIGINT, kind TEXT NOT NULL, relation TEXT, scope TEXT, law_form TEXT, law_text TEXT, dst_type TEXT,
    dst_doc TEXT, dst_name TEXT, unit TEXT, labels TEXT[], sub TEXT, in_quote BOOLEAN, confidence TEXT, via TEXT,
    span TEXT, span_start INT, span_end INT, status TEXT, unresolved TEXT[], date DATE, context TEXT, ops JSONB);
CREATE INDEX IF NOT EXISTS kb_mentions_src_idx ON kb.mentions (src_doc);
CREATE INDEX IF NOT EXISTS kb_mentions_src_chunk_idx ON kb.mentions (src_chunk);
CREATE INDEX IF NOT EXISTS kb_mentions_dst_idx ON kb.mentions (dst_doc);
"""


def vid_sql(col):
    """vid(uuid) in SQL: the uuid's first 48 bits (12 hex digits) + 2**50, equal to vid() below."""
    return f"(('x' || substr(replace({col}::text, '-', ''), 1, 12))::bit(48)::bigint + 1125899906842624)"


def date_sql(expr):
    return f"CASE WHEN pg_input_is_valid({expr}, 'date') THEN ({expr})::date END"


def doc_state(cur):
    """{key: fingerprint to publish}: the build fingerprint plus a hash of its mentions and links (a relink
    republishes only the documents whose citations or resolved targets changed)."""
    cur.execute("""SELECT d.key, coalesce(d.fingerprint, '') || '|' || coalesce(md5(string_agg(concat_ws(',', m.kind,
                     m.dst_doc, m.dst_name, array_to_string(m.labels, ' '), m.status, m.start_at, m.end_at, m.law_form,
                     m.confidence, m.src_chunk::text), ';' ORDER BY m.src_chunk, m.start_at, m.kind, m.dst_doc, m.id)), '')
                   FROM docs d LEFT JOIN mentions m ON m.src_doc = d.key GROUP BY d.key, d.fingerprint""")
    now = dict(cur.fetchall())
    cur.execute("""SELECT src_doc, md5(string_agg(concat_ws(',', src_chunk::text, kind, dst_doc, dst_label, dst_chunk::text, part),
                     ';' ORDER BY src_chunk, kind, dst_doc, dst_label, dst_chunk, part)) FROM links GROUP BY 1""")
    for k, h in cur.fetchall():
        now[k] = now.get(k, "") + "|" + h
    return now


MARKS = "CREATE TABLE IF NOT EXISTS marks (name TEXT PRIMARY KEY, value TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW())"


def _hash(d):
    return hashlib.md5("\n".join(f"{k}\t{d[k]}" for k in sorted(d)).encode()).hexdigest()


def mark(cur, name, value=None):
    """marks: `gated` = the state hash the quality gate last passed, `embedded` = the kb hash last embedded."""
    cur.execute(MARKS)
    if value is not None:
        cur.execute("""INSERT INTO marks (name, value) VALUES (%s, %s)
                       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, at = NOW()""", (name, value))
    cur.execute("SELECT value FROM marks WHERE name = %s", (name,))
    r = cur.fetchone()
    return r and r[0]


def checked(state, passed=None):
    """-> {state, gated}: a hash of every document's build and links now, and the one the gate last passed. With
    passed=h (the gate just passed state h), records it; refused if the state moved while the gate ran."""
    with state.cursor() as cur:
        now = _hash(doc_state(cur))
        if passed is not None:
            if passed != now:
                raise SystemExit(f"the state changed while the gate ran ({passed} -> {now}): not marked")
            mark(cur, "gated", passed)
        out = {"state": now, "gated": mark(cur, "gated")}
    state.commit()
    return out


def publish(state, apply=False):
    """-> counts; with apply, replaces the changed documents in kb.* in one transaction (all inside the database)."""
    with state.cursor() as cur:
        now = doc_state(cur)
        cur.execute("SELECT key, fingerprint FROM published")
        before = dict(cur.fetchall())
    state.commit()
    changed = [k for k, f in now.items() if before.get(k) != f]
    gone = [k for k in before if k not in now]
    out = {"documents": len(now), "to_publish": len(changed), "to_delete": len(gone)}
    if not apply or not (changed or gone):
        return out
    with state.cursor() as c:
        if mark(c, "gated") != _hash(now):   # only a state the quality gate passed reaches the app
            raise SystemExit("publish refused: the quality gate has not passed this state (etl.v2.run checked)")
        c.execute(KB_SCHEMA)
        c.execute("CREATE TEMP TABLE pub (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) ON COMMIT DROP")
        execute_values(c, "INSERT INTO pub VALUES %s", [(k, now[k]) for k in changed], page_size=5000)
        c.execute("DELETE FROM kb.docs WHERE key IN (SELECT key FROM pub) OR key = ANY(%s)", (gone,))  # cascades
        c.execute(f"""INSERT INTO kb.docs (key, kind, title, year, certified, commenced, commencement, long_title,
                                         source_url, parts, meta)
                      SELECT d.key, d.kind, d.title, d.year, {date_sql("d.meta->>'certified'")},
                             {date_sql("d.meta->>'commenced'")}, d.meta->'commencement', d.meta->>'long_title',
                             l.source_url, coalesce(d.parts, '{{}}'), d.meta
                      FROM docs d JOIN pub USING (key) LEFT JOIN documents x ON x.key = d.key
                      LEFT JOIN listings l ON l.id = x.listing_id""")
        c.execute(f"""INSERT INTO kb.chunks (id, uuid, doc_key, address, seq, label, kind, path, part, text_hash)
                      SELECT {vid_sql("c.id")}, c.id, c.doc_key, c.address, c.seq, c.label, c.kind, c.crumb, c.part, c.text_hash
                      FROM chunks c JOIN pub ON pub.key = c.doc_key""")
        c.execute(f"""INSERT INTO kb.mentions (id, src_doc, src_chunk, kind, relation, scope, law_form, law_text, dst_type,
                                             dst_doc, dst_name, unit, labels, sub, in_quote, confidence, via, span,
                                             span_start, span_end, status, unresolved, date, context, ops)
                      SELECT m.id, m.src_doc, {vid_sql("m.src_chunk")}, m.kind, m.relation, m.scope, m.law_form, m.law_text,
                             m.dst_type, m.dst_doc, m.dst_name, m.unit, m.labels, m.sub, m.in_quote, m.confidence, m.via,
                             m.span, m.start_at, m.end_at, m.status, m.unresolved, k.commenced, m.context, m.ops
                      FROM mentions m JOIN pub ON pub.key = m.src_doc JOIN kb.docs k ON k.key = m.src_doc""")
        c.execute(f"""INSERT INTO kb.links (src_doc, src_chunk, kind, dst_doc, dst_label, dst_chunk, status, date, context, detail,
                                          mention_id, relation, scope, law_form, confidence, in_quote, span, span_start,
                                          span_end, sub, dst_type, part, via_alias)
                      SELECT l.src_doc, {vid_sql("l.src_chunk")}, l.kind, l.dst_doc, l.dst_label, {vid_sql("l.dst_chunk")},
                             'resolved', k.commenced, m.context,
                             coalesce(m.detail, '{{}}'::jsonb) || CASE WHEN l.part IS NULL THEN '{{}}'::jsonb
                                                                       ELSE jsonb_build_object('part', l.part) END,
                             m.id, m.relation, m.scope, m.law_form, m.confidence, m.in_quote, m.span, m.start_at, m.end_at,
                             m.sub, m.dst_type, l.part, l.via_alias
                      FROM links l JOIN mentions m ON m.id = l.mention_id JOIN pub ON pub.key = l.src_doc
                      JOIN kb.docs k ON k.key = l.src_doc
                      UNION ALL   -- editions and old laws that are the same law (etl.graph link), as v1 published them
                      SELECT s.a, NULL, 'same_as', s.b, NULL, NULL, 'resolved', NULL, NULL, NULL,
                             NULL, 'same_as', 'whole_law', NULL, 'high', NULL, NULL, NULL, NULL, NULL, 'law', NULL, NULL
                      FROM same_as s JOIN pub ON pub.key = s.a""")
        c.execute("""INSERT INTO published (key, fingerprint) SELECT key, fingerprint FROM pub
                     ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, at = NOW()""")
        c.execute("DELETE FROM published WHERE key = ANY(%s)", (gone,))
    state.commit()   # the app sees the whole release at once, or nothing of it
    return out


# -- embed --------------------------------------------------------------------------------------------------------------
# Into the live collection `chunks` (decision 2026-11-07: no new collection), same schema (etl.embed.SCHEMA, Int64 id).
# A v2 chunk's vector id is vid(uuid): 48 bits of the uuid plus 2**50, so it never meets v1's ids (under 10**8) and the
# app maps a hit back with the same function. v1's rows stay until the app reads v2 (`--prune-v1` deletes them then).
# Every text is embedded again (bge-m3 on ada's GPU with EMBED_LOCAL=1, decision 2026-11-07): no copy by hash.

V2_BASE = 1 << 50


def vid(u):
    """uuid (str) -> the chunk's Int64 id in Zilliz."""
    import uuid
    return V2_BASE + (uuid.UUID(u).int >> 80)


def embed_texts(state):
    """[{id, text, hash, doc_key, kind, label, year}] for every chunk of 40+ chars, the text sent as v1 sends it
    ("title › breadcrumb" + the chunk), read from the R2 parts."""
    from etl import embed as E
    out = []
    with state.cursor() as cur:
        cur.execute("SELECT to_regclass('kb.docs') IS NOT NULL")
        docs = []
        if cur.fetchone()[0]:   # what the app sees: kb.docs, filled by publish
            cur.execute("SELECT key, kind, title, year, parts FROM kb.docs")
            docs = cur.fetchall()
    state.commit()
    # Parts are read on 16 threads (one after another took 24 minutes for 7,715 docs, 2026-11-08).
    from concurrent.futures import ThreadPoolExecutor
    B.r2()  # one client, made before the threads share it
    keys = [p for d in docs for p in d[4] or []]
    with ThreadPoolExecutor(16) as pool:
        got = dict(zip(keys, pool.map(B.get_json, keys)))
    for key, kind, title, year, parts in docs:
        for p in parts or []:
            for c in got[p]["chunks"]:
                if len(c["text"].strip()) < E.MIN:
                    continue
                t = " › ".join(x for x in (title or key, c.get("crumb")) if x) + "\n\n" + c["text"]
                out.append({"id": vid(c["id"]), "text": t[:65000], "hash": hashlib.sha1(t.encode()).hexdigest(),
                            "doc_key": key, "kind": kind, "label": c.get("label"), "year": year})
    ids = [r["id"] for r in out]
    assert len(ids) == len(set(ids)), "two chunks share a vector id"
    return out


def stored_v2(E, lo=V2_BASE, hi=V2_BASE + (1 << 48)):
    """{id: hash} for every v2 entity: id ranges, halved while a range comes back full (a query returns <= 16,384)."""
    got = E.zilliz("entities/query", {"collectionName": E.COLL, "filter": f"id >= {lo} and id < {hi}",
                                      "outputFields": ["id", "hash"], "limit": 16384})
    if len(got) < 16384:
        return {g["id"]: g["hash"] for g in got}
    mid = (lo + hi) // 2
    return {**stored_v2(E, lo, mid), **stored_v2(E, mid, hi)}


def embed(state, apply=False, prune_v1=False):
    """-> counts; with apply, upserts changed chunks and deletes gone v2 ids (and, with prune_v1, every v1 id)."""
    from etl import embed as E
    with state.cursor() as cur:   # kb's version = the published fingerprints (publish writes both in one transaction)
        cur.execute("SELECT key, fingerprint FROM published")
        kb = _hash(dict(cur.fetchall()))
        last = mark(cur, "embedded")
    state.commit()
    if kb == last and not prune_v1:
        return {"skipped": "kb unchanged since the last embed"}
    rows = embed_texts(state)
    have = stored_v2(E)
    ids = {r["id"] for r in rows}
    todo = [r for r in rows if have.get(r["id"]) != r["hash"]]
    gone = [i for i in have if i not in ids]
    out = {"chunks": len(rows), "in_index": len(have), "to_upsert": len(todo), "to_delete": len(gone)}
    if prune_v1:
        out["v1_to_delete"] = E.zilliz("entities/query", {"collectionName": E.COLL, "filter": f"id < {V2_BASE}",
                                                          "outputFields": ["count(*)"]})[0]["count(*)"]
    if not apply:
        return out
    batches = [[]]
    for r in todo:
        if len(batches[-1]) == E.BATCH or sum(len(x["text"]) for x in batches[-1]) + len(r["text"]) > E.CHARS:
            batches.append([])
        batches[-1].append(r)
    for n, b in enumerate(x for x in batches if x):
        vec = E.embed([r["text"] for r in b])
        E.zilliz("entities/upsert", {"collectionName": E.COLL, "data": [{**r, "vec": v} for r, v in zip(b, vec)]})
        if n % 50 == 0:
            print(f"embed {n * E.BATCH}/{len(todo)}", flush=True)
    for i in range(0, len(gone), 1000):
        E.zilliz("entities/delete", {"collectionName": E.COLL, "filter": f"id in {gone[i:i + 1000]}"})
    if prune_v1:
        E.zilliz("entities/delete", {"collectionName": E.COLL, "filter": f"id < {V2_BASE}"})
    # a fresh connection: a full embed leaves this one idle for hours, and Neon closes it (2026-11-08: 3 h of bge-m3,
    # then "SSL connection has been closed" on the mark)
    import psycopg2
    with psycopg2.connect(os.environ["V2_DATABASE_URL"]) as db, db.cursor() as cur:
        mark(cur, "embedded", kb)
    return out
