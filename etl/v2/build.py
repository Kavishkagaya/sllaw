"""Stages 4-5 as a pipeline stage (docs/PIPELINE_V2.md): a document's file -> tree -> chunks, stored.

  plan   every document with a chosen file; fingerprint = file sha256 + whether LightOn pages exist + the
         builder's code version + its profile + the human fixes naming it. Unchanged documents are not rebuilt.
  run    one document: blocks (stage 3 output in R2) -> tree -> chunks; writes, all under content-hash names so a
         rewrite of the same content is the same object:
           R2  <prefix>tree/<hash>.json      the tree (what chunking reads; inspectable between the stages)
           R2  <prefix>app/law/<hash>.json   the chunk text, one part per ~256 KB, cut at a unit boundary
           DB  docs, chunks (no text), issues (the checks)
         chunks whose address is gone are deleted; the rest upserted, so an unchanged chunk keeps its row.

Prefix: V2_R2_PREFIX ("" in production; "v2test/" for a trial run, so nothing lands beside the live objects).
"""
import gzip, hashlib, json, os, re

from etl.v2 import blocks as b3, checks, chunk as c5, tree as t4
from etl.v2.profiles import profile

# the builder's version: a hash of every source file its output depends on, so a code change rebuilds what it can
# affect and nothing needs bumping by hand (a hand-set constant left 5 trial documents stale, 2026-11-07)
_SRC = ["v2/blocks.py", "v2/tree.py", "v2/chunk.py", "v2/profiles.py", "v2/checks.py", "v2/build.py",
        "v2/dates.py", "structure.py", "docs.py", "refs.py"]
CODE = hashlib.sha1(b"".join(open(os.path.join(os.path.dirname(__file__), "..", f), "rb").read() for f in _SRC)).hexdigest()[:16]
PART_BYTES = 256_000
PREFIX = os.environ.get("V2_R2_PREFIX", "")
_r2 = {}


def r2():
    if "s3" not in _r2:
        from etl.fetch import r2 as client
        _r2["s3"], _r2["bucket"] = client(), os.environ["R2_BUCKET"]
    return _r2["s3"], _r2["bucket"]


def get_json(key):
    s3, bucket = r2()
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    return json.loads(gzip.decompress(body) if key.endswith(".gz") else body)


def put_json(prefix, value):
    """Store under its content hash -> key. A key that exists already is the same content: not sent again."""
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    key = f"{PREFIX}{prefix}{hashlib.sha256(body).hexdigest()[:32]}.json"
    s3, bucket = r2()
    try:
        s3.head_object(Bucket=bucket, Key=key)
    except s3.exceptions.ClientError:
        s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json",
                      CacheControl="public, max-age=31536000, immutable")
    return key


def fingerprint(sha, has_lighton, prof, fixes):
    """The prefix is part of it: a build written under another R2 prefix is not this build (2026-11-07)."""
    return hashlib.sha1(json.dumps([sha, has_lighton, CODE, prof, fixes, PREFIX], sort_keys=True).encode()).hexdigest()


def parts(chunks):
    """Chunks -> parts of about PART_BYTES, cut only where a new unit starts (a unit's pieces stay together)."""
    out, cur, size = [], [], 0
    for c in chunks:
        if cur and size > PART_BYTES and c["address"].endswith("/1"):
            out.append(cur)
            cur, size = [], 0
        cur.append(c)
        size += len(c["text"]) + len(c["address"]) + 60
    return out + [cur] if cur else out


def build_doc(key, title, raw, lo, meta):
    """In memory: -> (prof, engine, paras, stats, tree, info, chunks, issues)."""
    prof = profile(key, title)
    bs, engine = b3.read(raw, lo, le1980=bool(meta.get("cap")), spread=bool(meta.get("spread")),
                         gazette=bool(prof.get("gazette")))
    paras, st = b3.paragraphs(bs, engine, gazette=bool(prof.get("gazette")))
    tree, info = t4.build(paras, prof, key)
    ch = c5.chunks(key, tree, prof)
    return prof, engine, paras, st, tree, info, ch, checks.check(key, prof, paras, st, tree, info, ch)


def store(db, key, title, sha, prof, tree, ch, issues, fp, meta=None):
    """Write one built document: R2 objects first, then its rows in one transaction (the app-facing tables never
    name an object that is not there yet)."""
    tree_key = put_json("tree/", {"key": key, "tree": tree})
    groups = parts(ch)
    part_keys = [put_json("app/law/", {"doc": key, "chunks": [{k: c[k] for k in ("id", "address", "label", "crumb", "text")}
                                                              for c in g]}) for g in groups]
    part_of = {c["id"]: i for i, g in enumerate(groups) for c in g}
    year = int(m[1]) if (m := re.search(r"/(\d{4})$", key)) else None
    with db.cursor() as cur:
        cur.execute("""INSERT INTO docs (key, kind, title, year, sha256, tree_key, parts, fingerprint, meta, built_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
                       ON CONFLICT (key) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title, year = EXCLUDED.year,
                         sha256 = EXCLUDED.sha256, tree_key = EXCLUDED.tree_key, parts = EXCLUDED.parts,
                         fingerprint = EXCLUDED.fingerprint, meta = EXCLUDED.meta, built_at = NOW()""",
                    (key, prof["kind"], title, year, sha, tree_key, part_keys, fp, json.dumps(meta or {})))   # long_title, certified, commenced, commencement
        ids = [c["id"] for c in ch]
        cur.execute("DELETE FROM chunks WHERE doc_key = %s AND NOT (id::text = ANY(%s))", (key, ids))
        from psycopg2.extras import execute_values
        execute_values(cur, """INSERT INTO chunks (id, doc_key, address, seq, label, kind, crumb, part, text_hash) VALUES %s
                               ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq, label = EXCLUDED.label,
                                 kind = EXCLUDED.kind, crumb = EXCLUDED.crumb, part = EXCLUDED.part,
                                 text_hash = EXCLUDED.text_hash""",
                       [(c["id"], key, c["address"], i, c["label"], c["kind"], c["crumb"], part_of[c["id"]], c["text_hash"])
                        for i, c in enumerate(ch)], page_size=1000)
        cur.execute("DELETE FROM issues WHERE key = %s AND stage = 'build'", (key,))
        execute_values(cur, "INSERT INTO issues (key, stage, check_name, severity, place, page, evidence, cause) VALUES %s",
                       [(key, "build", i["check"], i["severity"], i["where"], i["page"], i["evidence"], i["cause"])
                        for i in issues] or [(key, "build", "built", "info", key, None, None, None)], page_size=1000)
    db.commit()
    return {"chunks": len(ch), "parts": len(part_keys), "tree": tree_key,
            "errors": sum(i["severity"] == "error" for i in issues), "warnings": sum(i["severity"] == "warn" for i in issues)}
