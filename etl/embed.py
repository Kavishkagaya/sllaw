#!/usr/bin/env python3
"""Chunks -> Zilliz Cloud collection `chunks`: bge-m3 vectors (Workers AI) + BM25 on the same text, issue #4.

  python3 -m etl.embed create        # once: the collection (fails if it exists)
  python3 -m etl.embed               # on ada: sync every chunk in ada's Postgres
  python3 -m etl.embed --limit 200   # pilot (no deletes)

Vector id = chunk id. Reads ada's Postgres, not Neon (no bulk reads out of Neon), and stops unless the app's Neon
holds the same chunk ids (etl.publish copies them): after a rebuild run `etl.docs build`, `etl.publish`, then this. `hash` = sha1 of the text sent to the model, used
only to see what changed. A sync reads (id, hash) for every entity and, per chunk: same id and hash -> skip; a hash
already stored under another id (a rebuilt doc gets new chunk ids, `etl.docs build` deletes and reinserts) -> copy
that vector, no model call; otherwise embed. Ids no longer in Postgres are deleted. Each batch is upserted as it
completes, so a stopped run resumes. The text sent is "law title › chunks.path" (the breadcrumb etl.docs builds:
Part, section and note, "(cont.)"; only what is certain) + the chunk. Zilliz computes `sparse` (BM25, English
analyzer) from `text` itself.
"""
import argparse, hashlib, os, threading, time
from concurrent.futures import ThreadPoolExecutor

import psycopg2, requests
from dotenv import load_dotenv

from etl.fetch import pg_connect

load_dotenv()

MODEL = "@cf/baai/bge-m3"   # 1024 dims; $0.0118/M tokens, 3,000 requests/min (Workers AI, 2026-10-16)
COLL = "chunks"
BATCH, CHARS, THREADS = 100, 150_000, 4   # Workers AI: 60,000 tokens per request, all texts together
MIN = 40                                  # chars of chunk text; shorter chunks get no vector
SPAN = 10_000                             # ids per state query (a REST query returns at most 16,384 rows)


def vc(name, n, **kw):
    return {"fieldName": name, "dataType": "VarChar", "elementTypeParams": {"max_length": n, **kw}}


SCHEMA = {"autoId": False, "enableDynamicField": False, "fields": [
    {"fieldName": "id", "dataType": "Int64", "isPrimary": True},
    {"fieldName": "vec", "dataType": "FloatVector", "elementTypeParams": {"dim": 1024}},
    {"fieldName": "sparse", "dataType": "SparseFloatVector"},
    vc("text", 65535, enable_analyzer=True, analyzer_params={"type": "english"}),
    vc("hash", 40), vc("doc_key", 64), vc("kind", 32), {**vc("label", 64), "nullable": True},
    {"fieldName": "year", "dataType": "Int32", "nullable": True}],
    "functions": [{"name": "bm25", "type": "BM25", "inputFieldNames": ["text"], "outputFieldNames": ["sparse"]}]}
INDEXES = [{"fieldName": "vec", "indexName": "vec", "metricType": "COSINE", "params": {"index_type": "AUTOINDEX"}},
           {"fieldName": "sparse", "indexName": "sparse", "metricType": "BM25", "params": {"index_type": "AUTOINDEX"}}]
INDEXES += [{"fieldName": f, "indexName": f, "params": {"index_type": "AUTOINDEX"}} for f in ("doc_key", "kind", "year")]


def zilliz(path, body):
    for i in range(6):
        try:
            r = requests.post(f"{os.environ['ZILLIZ_URI']}/v2/vectordb/{path}", json=body, timeout=120,
                              headers={"Authorization": f"Bearer {os.environ['ZILLIZ_TOKEN']}"})
            d = r.json()
            if d.get("code") == 0:
                return d.get("data")
            err = f"{d.get('code')}: {d.get('message')}"
        except (requests.RequestException, ValueError) as e:
            err = str(e)
        if i == 5:
            raise RuntimeError(f"zilliz {path}: {err}")
        time.sleep(2 ** i * 5)   # upsert and delete are idempotent, so a timed-out call is safe to repeat


def texts(cur):
    """One dict per chunk worth a vector, in document order: the entity to store, minus `vec`. Chunks under
    MIN chars ("Chapter 181,", a stray page number) stay in Postgres for links but get no vector."""
    cur.execute("SELECT c.id, c.doc_key, c.label, c.path, c.text, d.title, d.kind, d.year FROM chunks c "
                "JOIN docs d ON d.key = c.doc_key ORDER BY c.doc_key, c.seq")
    out = []
    for cid, key, label, path, text, title, kind, year in cur.fetchall():
        if len(text.strip()) < MIN:
            continue
        t = " › ".join(x for x in (title or key, path) if x) + "\n\n" + text
        out.append({"id": cid, "text": t, "hash": hashlib.sha1(t.encode()).hexdigest(), "doc_key": key,
                    "kind": kind, "label": label, "year": year})
    return out


def stored():
    """{id: hash} for every entity, read in id ranges until all Zilliz holds is seen: a rebuild on a fresh database
    numbers chunks from 1 while the stored ids are the old database's (ada's ran 90,778-199,554), so scanning only up
    to the new top missed 75k vectors, which would have been embedded again and never deleted (2026-10-19)."""
    total = zilliz("entities/query", {"collectionName": COLL, "filter": "id >= 0", "outputFields": ["count(*)"]})[0]["count(*)"]
    have, lo = {}, 0
    while len(have) < total and lo < 100_000_000:
        for e in zilliz("entities/query", {"collectionName": COLL, "filter": f"id >= {lo} and id < {lo + SPAN}",
                                           "outputFields": ["id", "hash"], "limit": SPAN}):
            have[e["id"]] = e["hash"]
        lo += SPAN
    return have


_local, _lock = {}, threading.Lock()


def embed_local(texts):
    """bge-m3 dense vectors on this machine's GPU, the same open weights Workers AI runs (CLS token, normalized):
    for testing and development when the Workers AI free allocation is spent (user, 2026-10-17). On with
    EMBED_LOCAL=1; the weights come from the Hugging Face cache (ada: HF_HOME=/var/tmp/e19309/hf)."""
    with _lock:             # the imports too: transformers' lazy import is not thread-safe (4 threads, 2026-10-19)
        import torch
        from transformers import AutoModel, AutoTokenizer
        if not _local:      # both or neither: a failed load (CUDA OOM on a shared card) must not leave half a cache
            tok = AutoTokenizer.from_pretrained("BAAI/bge-m3")
            model = AutoModel.from_pretrained("BAAI/bge-m3", dtype=torch.float16).cuda().eval()
            _local.update(tok=tok, model=model)
        out = []
        for i in range(0, len(texts), 16):
            b = _local["tok"](texts[i:i + 16], padding=True, truncation=True, max_length=8192,
                              return_tensors="pt").to("cuda")
            with torch.no_grad():
                v = _local["model"](**b).last_hidden_state[:, 0]
            out += torch.nn.functional.normalize(v.float(), dim=-1).tolist()
        return out


def embed(texts):
    if os.environ.get("EMBED_LOCAL"):
        return embed_local(texts)
    url =f"https://api.cloudflare.com/client/v4/accounts/{os.environ['R2_ACCOUNT_ID']}/ai/run/{MODEL}"
    for i in range(6):
        r = requests.post(url, json={"text": texts}, timeout=120,
                          headers={"Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN']}"})
        if r.status_code == 400 and "Max context" in r.text and len(texts) > 1:   # split, not shrink every batch
            return embed(texts[:len(texts) // 2]) + embed(texts[len(texts) // 2:])
        if r.ok:
            data = r.json()["result"]["data"]
            assert len(data) == len(texts), f"{len(data)} vectors for {len(texts)} texts"
            return data
        if r.status_code not in (429, 500, 502, 503, 504) or i == 5:
            raise RuntimeError(f"{r.status_code}: {r.text[:500]}")
        time.sleep(2 ** i * 5)


def sync(batch, old):
    """Vectors for a batch (copied from `old` = {hash: stored id} where possible, else embedded), then upsert."""
    copy = {e["hash"]: old[e["hash"]] for e in batch if e["hash"] in old}
    vec = {}
    if copy:
        got = zilliz("entities/query", {"collectionName": COLL, "filter": f"id in {list(set(copy.values()))}",
                                        "outputFields": ["id", "vec", "hash"], "limit": len(copy)})
        # the hash must still match: when new ids overlap old ones another batch may have overwritten that id already
        by_id = {e["id"]: (e["vec"], e["hash"]) for e in got}
        vec = {h: by_id[i][0] for h, i in copy.items() if i in by_id and by_id[i][1] == h}
    new = list({e["hash"]: e["text"] for e in batch if e["hash"] not in vec}.items())
    if new:
        vec.update(zip([h for h, _ in new], embed([t for _, t in new])))
    zilliz("entities/upsert", {"collectionName": COLL, "data": [{**e, "vec": vec[e["hash"]]} for e in batch]})
    return len(batch) - len(new), len(new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", choices=["create"])
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    if a.cmd == "create":
        zilliz("collections/create", {"collectionName": COLL, "schema": SCHEMA, "indexParams": INDEXES})
        print(f"created {COLL}")
        return
    ids_sql = "SELECT count(*), max(id), sum(id) FROM chunks"   # one row back from Neon
    with psycopg2.connect(os.environ["DB_LOCAL_URL"]) as db, db.cursor() as cur:
        cur.execute(ids_sql)
        here = cur.fetchone()
        rows = texts(cur)
    with pg_connect(url=os.environ["APP_DATABASE_URL"]) as app, app.cursor() as cur:
        cur.execute(ids_sql)
        there = cur.fetchone()
    if here != there:
        raise SystemExit(f"chunk ids differ: ada {here}, Neon {there}; run etl.publish first")
    ids = {e["id"] for e in rows}
    have = stored()
    old = {h: i for i, h in have.items()}
    todo = [e for e in rows if have.get(e["id"]) != e["hash"]][:a.limit]
    gone = [i for i in have if i not in ids]
    print(f"{len(rows)} chunks, {len(have)} stored, {len(todo)} to upsert, {len(gone)} to delete", flush=True)
    batches = [[]]
    for e in todo:
        if len(batches[-1]) == BATCH or sum(len(x["text"]) for x in batches[-1]) + len(e["text"]) > CHARS:
            batches.append([])
        batches[-1].append(e)
    batches = [b for b in batches if b]
    t0, done, copied, sent = time.time(), 0, 0, 0
    with ThreadPoolExecutor(THREADS) as pool:
        for b, (c, s) in zip(batches, pool.map(lambda b: sync(b, old), batches)):
            done, copied, sent = done + len(b), copied + c, sent + s
            print(f"{done}/{len(todo)} ({copied} copied, {sent} embedded) in {time.time() - t0:.0f}s", flush=True)
    # after the upserts: a copy above may read a vector stored under an id that is gone now
    if a.limit is None:
        for i in range(0, len(gone), 1000):
            zilliz("entities/delete", {"collectionName": COLL, "filter": f"id in {gone[i:i + 1000]}"})
        print(f"deleted {len(gone)}", flush=True)


if __name__ == "__main__":
    main()
