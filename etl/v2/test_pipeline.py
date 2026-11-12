"""python -m etl.v2.test_pipeline -- the Dagster job's retry rules (needs dagster: run in ampere's dagster_venv)."""
import inspect

import dagster as dg

from etl.v2 import pipeline as P

assert P.sllaw_v2.op_retry_policy == dg.RetryPolicy(max_retries=2, delay=120, backoff=dg.Backoff.EXPONENTIAL)
d = P.RETRY.delay
assert [d * 2 ** i for i in range(P.RETRY.max_retries)] == [120, 240], "2 then 4 minutes"
for op in (P.link_gold, P.quality_gate):        # a check that finds bad data fails at once
    src = inspect.getsource(op.compute_fn.decorated_fn)
    fails = [l for l in src.splitlines() if "raise dg.Failure(" in l]
    assert fails and src.count("allow_retries=False") == len(fails) - (op is P.link_gold), (op.name, fails)
print("ok retries: every op 2x (2, 4 min); gold and gate verdicts never")
