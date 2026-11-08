"""python3 -m etl.v2.test_work -- the work queue (etl/v2/work.py) on V2_DATABASE_URL, under a throwaway stage name."""
import os

import psycopg2

from etl.v2 import work as W

db = psycopg2.connect(os.environ["V2_DATABASE_URL"])
S = "test-queue"
with db.cursor() as cur:
    cur.execute("DELETE FROM work WHERE stage = %s OR (stage = 'lock' AND item = 'test-lock')", (S,))
db.commit()
try:
    assert W.plan(db, S, [("a", "1"), ("b", "1"), ("c", "1")]) == (3, 0)
    assert W.plan(db, S, [("a", "1"), ("b", "2"), ("c", "1")]) == (1, 2)          # only b changed
    got = W.claim(db, S, 2, worker="w1")
    assert len(got) == 2
    other = W.claim(db, S, 5, worker="w2")                                         # never the same items
    assert {i for i, _ in got}.isdisjoint({i for i, _ in other}) and len(got) + len(other) == 3
    for i, f in got:
        W.finish(db, S, i, f, {"ok": True}, worker="w1")
    i, f = other[0]
    W.fail(db, S, i, "boom", worker="w2")
    again = W.claim(db, S, 5, worker="w3")                                         # a failed item comes back
    assert [x for x, _ in again] == [i], again
    W.finish(db, S, i, f, None, worker="w3")
    assert W.claim(db, S, 5, worker="w4") == []
    assert W.plan(db, S, [("a", "1"), ("b", "2"), ("c", "1")]) == (0, 3)          # a rerun has nothing to do
    # finishing an item whose fingerprint moved on while it was worked on leaves it todo
    W.plan(db, S, [("a", "9")])
    (it, fp), = W.claim(db, S, 1, worker="w5")
    W.plan(db, S, [("a", "10")])
    W.finish(db, S, it, fp, None, worker="w5")
    with db.cursor() as cur:
        cur.execute("SELECT status FROM work WHERE stage = %s AND item = 'a'", (S,))
        assert cur.fetchone()[0] == "todo"
    db.commit()
    assert W.singleton(db, "test-lock", worker="x") and not W.singleton(db, "test-lock", worker="y")
    W.release(db, "test-lock", worker="x")
    assert W.singleton(db, "test-lock", worker="y")
    print("ok work queue")
finally:
    with db.cursor() as cur:
        cur.execute("DELETE FROM work WHERE stage = %s OR (stage = 'lock' AND item = 'test-lock')", (S,))
    db.commit()
