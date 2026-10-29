#!/usr/bin/env python3
"""Recall of search over Zilliz `chunks` (issue #4): etl/eval_questions.json, each question in English, Sinhala and
Tamil with the section that answers it, run as dense (bge-m3), BM25 and hybrid (RRF) search.

  python3 -m etl.eval_search            # recall@1/5/10 per mode and language, then the misses

A hit counts when its law has the gold law's title (the 1956 and 1980 editions of a chapter both count) and its
breadcrumb names the gold section, first piece or "(cont.)". Questions whose gold chunk has no vector are skipped.
"""
import json, os, re

from dotenv import load_dotenv

from etl.embed import COLL, embed, zilliz

load_dotenv()
K = 10


def search(mode, q, vec):
    out = ["doc_key", "text"]
    if mode == "weighted":   # dense 0.7 + BM25 0.3; BM25 skipped for non-Latin text (the English analyzer reads none)
        if re.search(r"[\u0D80-\u0DFF\u0B80-\u0BFF]", q):
            return search("dense", q, vec)
        return zilliz("entities/hybrid_search", {"collectionName": COLL, "limit": K, "outputFields": out,
                      "search": [{"data": [vec], "annsField": "vec", "limit": 30},
                                 {"data": [q], "annsField": "sparse", "limit": 30}],
                      "rerank": {"strategy": "weighted", "params": {"weights": [0.7, 0.3]}}})
    if mode == "hybrid":
        return zilliz("entities/hybrid_search", {"collectionName": COLL, "limit": K, "outputFields": out,
                      "search": [{"data": [vec], "annsField": "vec", "limit": 30},
                                 {"data": [q], "annsField": "sparse", "limit": 30}],
                      "rerank": {"strategy": "rrf", "params": {"k": 60}}})
    return zilliz("entities/search", {"collectionName": COLL, "limit": K, "outputFields": out,
                  "data": [vec if mode == "dense" else q], "annsField": "vec" if mode == "dense" else "sparse"})


def head(hit):
    t, _, path = hit["text"].split("\n\n")[0].partition(" › ")
    return t.strip().lower(), path


def main():
    qs = json.load(open(os.path.join(os.path.dirname(__file__), "eval_questions.json")))
    # the gold chunk by law and label, not by its stored id: a rebuild gives a law's chunks new ids (every id was
    # stale after the 2026-10-20 rebuild, so every mode scored 0% until 2026-10-29)
    have = {}
    for q in qs:
        got = zilliz("entities/query", {"collectionName": COLL, "limit": 1, "outputFields": ["id", "text"],
                     "filter": f'doc_key == "{q["doc"]}" and label == "{q["label"]}"'})
        if got:
            have[q["id"]] = got[0]
    qs = [q for q in qs if q["id"] in have]
    print(f"{len(qs)} questions with an embedded gold chunk")
    langs, modes = ("en", "si", "ta"), ("dense", "bm25", "hybrid", "weighted")
    vecs = dict(zip([(q["id"], l) for q in qs for l in langs], embed([q[l] for q in qs for l in langs])))
    ranks, miss = {}, []
    for q in qs:
        title = head(have[q["id"]])[0]
        sec = re.compile(rf"\bsection {re.escape(q['label'])}(?: |$)")
        for l in langs:
            for m in modes:
                hits = search(m, q[l], vecs[(q["id"], l)])
                r = next((i for i, h in enumerate(hits, 1) if head(h)[0] == title and sec.search(head(h)[1])), None)
                ranks[(m, l, q["id"])] = r
                if l == "en" and m == "dense" and r is None:
                    miss.append((q, [head(h) for h in hits[:3]]))
    print(f"\n{'mode':8}{'lang':6}{'@1':>6}{'@5':>6}{'@10':>6}")
    for m in modes:
        for l in langs:
            rs = [ranks[(m, l, q["id"])] for q in qs]
            print(f"{m:8}{l:6}" + "".join(f"{sum(1 for r in rs if r and r <= k) / len(rs):6.0%}" for k in (1, 5, 10)))
    for q, top in miss:
        print(f"\nMISS (dense, en) {q['doc']} s{q['label']}: {q['en']}\n  got: {top}")


if __name__ == "__main__":
    main()
