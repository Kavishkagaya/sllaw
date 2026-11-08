"""The v2 pipeline as a Dagster job (decision 2026-11-08: Dagster). Dagster only orchestrates: every op runs the
same `python -m etl.v2.run ...` commands a person or cron would, in the ETL's own venvs, and the state database's
queue (etl/v2/work.py) stays the source of truth, so an op can be retried, a run can be cut short, and other hosts
can add workers to a stage while it runs.

  listing (one op per spider, in parallel) -> fetch -> extract -> ocr -> build -> links -> resolve
      -> link gold set (fails below 210/210) -> quality gate (fails on any error outside gazettes)
      -> publish -> embed   (dry runs unless the run config says apply: publish fills the kb schema the app reads, embed the search index)

Each stage op is `plan`, then N workers until the queue is empty (none when nothing is queued); it fails if more than
1% of items ended `failed` (3 tries). The checks run only when the state changed since the gate last passed (table
`marks`), publish --apply refuses a state the gate has not passed, and embed skips when kb has not changed, so a
day with nothing new costs the listings and a few queries. Daily at 02:00 Colombo (`daily`, turned on in the UI).
Env: SLLAW_ENV_FILE (default /var/tmp/e19309/neon.env: V2_DATABASE_URL and V2_R2_PREFIX, both required) on top of
~/sllaw/.env. Start on ampere with `bash etl/v2/dagster.sh` (web UI on 127.0.0.1:3070, daemon for the schedule).
"""
import json, os, re, subprocess, threading

import dagster as dg

ROOT = os.path.expanduser("~/sllaw")
PY = os.environ.get("SLLAW_PY", "/var/tmp/e19309/etl_venv/bin/python")
PY_DOCLING = os.environ.get("SLLAW_PY_DOCLING", "/var/tmp/e19309/sllaw_venv/bin/python")   # extract needs docling
SPIDERS = ["documents.gov.lk/acts", "documents.gov.lk/gazettes", "parliament.lk/acts", "parliament.lk/constitution",
           "lankalaw/acts-by-year", "lankalaw/le1980", "lankalaw/le1956"]          # = etl/v2/stages.py SPIDERS


def env():
    path = os.environ.get("SLLAW_ENV_FILE", "/var/tmp/e19309/neon.env")
    kv = dict(l.split("=", 1) for l in open(path).read().splitlines() if "=" in l and not l.startswith("#"))
    for k in ("V2_DATABASE_URL", "V2_R2_PREFIX"):          # where state and R2 output go is always said, never defaulted
        if k not in kv:
            raise dg.Failure(f"{k} missing from {path}")
    return {**os.environ, **kv, "PYTHONUNBUFFERED": "1"}


def run(context, args, py=PY, tail=60, extra=None, quiet=False):
    """One etl.v2 command; its output goes to the op's log (not with quiet). -> the last `tail` lines."""
    if not quiet:
        context.log.info(" ".join(["python -m", *args]))
    p = subprocess.Popen([py, "-u", "-m", *args], cwd=ROOT, env={**env(), **(extra or {})}, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True)
    out = []
    for line in p.stdout:
        line = line.rstrip()
        if line and not re.match(r"^\d+:T[0-9a-f]+", line):      # RSC text-row echoes from the gazette spider
            if not quiet:
                context.log.info(line)
            out.append(line)
    if p.wait():
        raise dg.Failure(f"{' '.join(args)} exited {p.returncode}", metadata={"tail": "\n".join(out[-tail:])})
    return out[-tail:]


def counts(context, quiet=False):
    """{(stage, status): n} from `run status`."""
    got = {}
    for line in run(context, ["etl.v2.run", "status"], tail=200, quiet=quiet):
        m = re.match(r"^(\S+) (\S+) (\d+)$", line)
        if m:
            got[(m[1], m[2])] = int(m[3])
    return got


def stage(context, name, workers, py=PY, extra=None, plan=True):
    """plan, then `workers` workers until the queue is empty; fails if any item ended failed."""
    if plan:
        run(context, ["etl.v2.run", "plan", name], py=py)
    c = counts(context, quiet=True)
    if not c.get((name, "todo"), 0) and not c.get((name, "running"), 0):
        context.log.info(f"{name}: nothing to do")
        context.add_output_metadata({"todo": 0})
        return {"todo": 0}
    errs = []

    def one(i):
        try:
            run(context, ["etl.v2.run", "work", name, "--n", "2"], py=py, extra=extra)
        except dg.Failure as e:
            errs.append(f"worker {i}: {e.description}")
    ts = [threading.Thread(target=one, args=(i,)) for i in range(workers)]
    for t in ts:
        t.start()
    while any(t.is_alive() for t in ts):          # the queue's counts every minute, so a slow stage is visibly moving
        ts[0].join(60)
        if any(t.is_alive() for t in ts):
            c = counts(context, quiet=True)
            context.log.info(f"{name}: " + ", ".join(f"{s} {c.get((name, s), 0)}" for s in ("done", "running", "todo", "failed")))
    for t in ts:
        t.join()
    c = counts(context)
    meta = {s: c.get((name, s), 0) for s in ("done", "failed", "todo", "running")}
    context.add_output_metadata(meta)
    # a few failed items must not stop the corpus (2026-11-08: one slow gazette held up 7,674 documents): the stage
    # fails on a crashed worker or on more than 1% failed (at least 3); fewer are listed and the run goes on
    limit = max(3, (meta["done"] + meta["failed"]) // 100)
    if errs or meta["failed"] > limit:
        raise dg.Failure(f"{name}: {meta['failed']} items failed (limit {limit}); {len(errs)} workers crashed",
                         metadata={**meta, "workers": "\n".join(errs)[:4000]})
    if meta["failed"]:
        context.log.warning(f"{name}: {meta['failed']} items failed (limit {limit}); see `work` rows with status failed")
    return meta


class Workers(dg.Config):
    fetch: int = 4
    extract: int = 4
    ocr: int = 2
    build: int = 12
    links: int = 12


class Apply(dg.Config):
    apply: bool = False       # publish / embed write only when a run says so


def _listing_op(spider):
    @dg.op(name="listing_" + re.sub(r"\W+", "_", spider), tags={"stage": "listing"})
    def op(context: dg.OpExecutionContext):
        """A site that fails keeps its last listing (etl.v2.run listing catches it): the op says so, the run goes on."""
        out = run(context, ["etl.v2.run", "listing", spider])
        failed = [l for l in out if " FAILED " in l]
        context.add_output_metadata({"result": "\n".join(out[-3:])})
        if failed:
            context.log.warning("\n".join(failed))
        return len(failed)
    return op


LISTINGS = [_listing_op(s) for s in SPIDERS]


@dg.op(ins={"listed": dg.In(list)}, tags={"stage": "fetch"})
def fetch(context: dg.OpExecutionContext, config: Workers, listed):
    return stage(context, "fetch", config.fetch)


@dg.op(ins={"after": dg.In(dg.Nothing)}, tags={"stage": "extract"})
def extract(context: dg.OpExecutionContext, config: Workers):
    return stage(context, "extract", config.extract, py=PY_DOCLING)


T = "/var/tmp/e19309"
OCR_MODELS = {k: v for k, v in json.load(open(os.path.join(os.path.dirname(__file__), "ocr_models.json"))).items()
              if k != "_"}
OCR_PORT = 8021
OCR_GB = 16          # what one LightOn server takes on a card (gpu-memory-utilization 0.3 of 48 GB, etl/ocr_ada.sh)


def free_gpu():
    """(index, free MiB, total MiB) of the card with the most free memory (the hosts are shared: never hard-code)."""
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.free,memory.total", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, check=True).stdout
    return max((tuple(int(x) for x in l.split(",")) for l in out.strip().splitlines()), key=lambda g: g[1])


def lighton(context, lang, prof, workers):
    """Start the language's LightOn model on the freest GPU, read that language's queue, stop the server."""
    import signal, time, urllib.request
    gpu, free, total = free_gpu()
    if free < OCR_GB * 1024:
        context.log.warning(f"{lang}: no GPU with {OCR_GB} GB free (best: card {gpu}, {free} MiB); scans stay queued")
        return {"skipped": "no free GPU"}
    mem = round(min(0.3, OCR_GB * 1024 / total), 2)
    log = open(os.path.expanduser(f"~/sllaw/logs/ocr_{lang.lower()}_{time.strftime('%Y%m%d_%H%M')}.log"), "w")
    srv_env = {**os.environ, "CUDA_VISIBLE_DEVICES": str(gpu), "VLLM_USE_FLASHINFER_SAMPLER": "0",   # see etl/ocr_ada.sh
               "PATH": f"{T}/lighton_venv/bin:/usr/local/cuda-13/bin:" + os.environ["PATH"],
               "HF_HOME": f"{T}/hf", "XDG_CACHE_HOME": f"{T}/cache", "VLLM_CACHE_ROOT": f"{T}/cache/vllm"}
    cmd = ["vllm", "serve", prof["model"], "--served-model-name", "lighton", "--port", str(OCR_PORT),
           "--gpu-memory-utilization", str(mem), "--max-model-len", str(prof["max_model_len"]),
           "--limit-mm-per-prompt", '{"image": 1}']
    if prof.get("chat_template_kwargs"):
        cmd += ["--default-chat-template-kwargs", json.dumps(prof["chat_template_kwargs"])]
    srv = subprocess.Popen(cmd, env=srv_env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    context.log.info(f"{lang}: {os.path.basename(prof['model'])} starting on card {gpu} ({free} MiB free), log {log.name}")
    try:
        for _ in range(180):                                   # up to 15 minutes to load
            if srv.poll() is not None:
                raise dg.Failure(f"{lang}: the OCR server exited {srv.returncode} while loading; see {log.name}")
            try:
                urllib.request.urlopen(f"http://localhost:{OCR_PORT}/health", timeout=5)
                break
            except Exception:
                time.sleep(5)
        else:
            raise dg.Failure(f"{lang}: the OCR server was not up after 15 minutes; see {log.name}")
        context.log.info(f"{lang}: server up")
        return stage(context, f"ocr-{lang}", workers, py=PY_DOCLING, plan=False,
                     extra={"V2_OCR_API": f"http://localhost:{OCR_PORT}/v1"})
    finally:
        try:                                         # the server may have exited already (a failed load)
            os.killpg(srv.pid, signal.SIGTERM)
            srv.wait(60)
        except subprocess.TimeoutExpired:
            os.killpg(srv.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        context.log.info(f"{lang}: server stopped")


def drain(context, name, host, stall=1800, limit=4 * 3600):
    """Wait for another host's workers to empty a queue (they claim from the same state DB). Progress every minute;
    no item finished for `stall` seconds -> a warning and the run goes on (the items stay queued for next time)."""
    import time
    t0 = last_t = time.time()
    last = None
    while time.time() - t0 < limit:
        c = counts(context, quiet=True)
        now = {s: c.get((name, s), 0) for s in ("done", "running", "todo", "failed")}
        if now != last:
            context.log.info(f"{name} on {host}: " + ", ".join(f"{k} {v}" for k, v in now.items()))
            if last is None or now["done"] + now["failed"] > last["done"] + last["failed"]:
                last_t = time.time()
            last = now
        if not now["todo"] and not now["running"]:
            return now
        if time.time() - last_t > stall:
            context.log.warning(f"{name}: nothing finished on {host} for {stall // 60} min; is etl/v2/ocr_host.sh "
                                f"running there? The run goes on, the scans stay queued")
            return {**now, "stalled": True}
        time.sleep(60)
    return {**last, "timeout": True}


@dg.op(ins={"after": dg.In(dg.Nothing)}, tags={"stage": "ocr"})
def ocr(context: dg.OpExecutionContext, config: Workers):
    """Scans extract left, per language (ocr_models.json): for each language with scans waiting, its LightOn model
    is started on the freest GPU, reads them, and is stopped (the cards are shared; one model at a time). Nothing
    waiting -> no model is loaded. No card with room -> the scans stay queued for the next run and the run goes on."""
    out = {}
    for lang, prof in OCR_MODELS.items():
        if prof.get("enabled") is False:            # a model switched off in ocr_models.json: its scans wait
            context.log.warning(f"{lang}: OCR off ({prof.get('why_disabled', 'no reason given')})")
            out[lang] = {"skipped": "disabled"}
            continue
        run(context, ["etl.v2.run", "plan", f"ocr-{lang}"])
        todo = counts(context).get((f"ocr-{lang}", "todo"), 0)
        out[lang] = {"waiting": todo}
        if not todo:
            continue
        if prof.get("host"):                       # served by workers on another host (etl/v2/ocr_host.sh there)
            out[lang].update(drain(context, f"ocr-{lang}", prof["host"]))
        else:
            out[lang].update(lighton(context, lang, prof, config.ocr) or {})
    context.add_output_metadata({k: json.dumps(v) for k, v in out.items()})
    return out


@dg.op(ins={"after": dg.In(dg.Nothing)}, tags={"stage": "build"})
def build(context: dg.OpExecutionContext, config: Workers):
    return stage(context, "build", config.build)


@dg.op(ins={"after": dg.In(dg.Nothing)}, tags={"stage": "links"})
def links(context: dg.OpExecutionContext, config: Workers):
    return stage(context, "links", config.links)


@dg.op(ins={"after": dg.In(dg.Nothing)})
def resolve(context: dg.OpExecutionContext):
    out = run(context, ["etl.v2.run", "resolve"])
    context.add_output_metadata({"result": "\n".join(out)})


def checked(context, passed=None):
    out = run(context, ["etl.v2.run", "checked", *(["--passed", passed] if passed else [])], quiet=True)
    return json.loads(next(l for l in out if l.startswith("checked "))[8:])


@dg.op(ins={"after": dg.In(dg.Nothing)})
def changes(context: dg.OpExecutionContext):
    """The state's hash and the one the gate last passed: equal -> nothing changed, the checks are skipped."""
    got = checked(context)
    context.log.info("unchanged since the gate last passed" if got["state"] == got["gated"] else f"state {got['state']}: to check")
    return got


@dg.op
def link_gold(context: dg.OpExecutionContext, got: dict):
    """The 210 hand-labelled links: every one must be right."""
    if got["state"] == got["gated"]:
        context.log.info("skipped: nothing changed since the gate last passed")
        return got
    out = run(context, ["etl.v2.run", "gold-links"])
    m = next((re.match(r"total (\d+)/(\d+)", l) for l in out if l.startswith("total")), None)
    if not m:
        raise dg.Failure("no total in gold-links output")
    context.add_output_metadata({"gold": f"{m[1]}/{m[2]}"})
    if m[1] != m[2]:
        raise dg.Failure(f"link gold set {m[1]}/{m[2]}", metadata={"misses": "\n".join(l for l in out if l.startswith("MISS"))})
    return got


@dg.op
def quality_gate(context: dg.OpExecutionContext, got: dict):
    """etl.v2.gate on every document: never worse than today. Fails on an error-level issue in anything but a
    gazette (gazette errors are known: odd layouts, docs/PIPELINE_V2.md) and on a structure gold miss. A pass is
    recorded against the state's hash (publish --apply needs it)."""
    if got["state"] == got["gated"]:
        context.log.info("skipped: nothing changed since the gate last passed")
        return
    out = run(context, ["etl.v2.gate", "--workers", "8"], tail=400)
    errors = [l.strip() for l in out if "[error]" in l]
    gold = next((l.strip() for l in out if l.strip().startswith("v2   :")), "")
    context.add_output_metadata({"errors": "\n".join(errors) or "none", "structure gold": gold,
                                 "summary": "\n".join(out[-60:])})
    bad = [l for l in errors if re.search(r"\((?!gazette \d+\))", l)]   # a kind other than gazette in the breakdown
    if bad or (gold and "laws exactly right 50/50" not in gold):
        raise dg.Failure("quality gate: " + "; ".join(bad or [gold]))
    checked(context, passed=got["state"])
    context.log.info(f"passed: state {got['state']} marked")


@dg.op(ins={"after": dg.In(dg.Nothing)})
def publish(context: dg.OpExecutionContext, config: Apply):
    out = run(context, ["etl.v2.run", "publish", *(["--apply"] if config.apply else [])])
    context.add_output_metadata({"result": out[-1] if out else "", "applied": config.apply})


@dg.op(ins={"after": dg.In(dg.Nothing)})
def embed(context: dg.OpExecutionContext, config: Apply):
    out = run(context, ["etl.v2.run", "embed", *(["--apply"] if config.apply else [])])
    context.add_output_metadata({"result": out[-1] if out else "", "applied": config.apply})


@dg.op(ins={"results": dg.In(list)})
def gather(results):
    return results


@dg.job(description="sllaw v2: listing -> fetch -> extract -> ocr -> build -> links -> resolve -> checks -> publish -> embed")
def sllaw_v2():
    after_listing = fetch(gather([op() for op in LISTINGS]))
    done = resolve(links(build(ocr(extract(after_listing)))))
    gated = quality_gate(link_gold(changes(done)))
    embed(publish(gated))


APPLY = {"ops": {"publish": {"config": {"apply": True}}, "embed": {"config": {"apply": True}}}}


@dg.schedule(job=sllaw_v2, cron_schedule="0 2 * * *", execution_timezone="Asia/Colombo",
             default_status=dg.DefaultScheduleStatus.STOPPED)   # turned on by hand, in the UI
def daily(context: dg.ScheduleEvaluationContext):
    """Every day, writing (publish and embed apply); skipped while a run is still going (a full rebuild takes hours)."""
    active = context.instance.get_runs(dg.RunsFilter(job_name="sllaw_v2", statuses=[
        dg.DagsterRunStatus.QUEUED, dg.DagsterRunStatus.NOT_STARTED, dg.DagsterRunStatus.STARTING,
        dg.DagsterRunStatus.STARTED]), limit=1)
    if active:
        return dg.SkipReason(f"run {active[0].run_id[:8]} is still going")
    return dg.RunRequest(run_config=APPLY)


defs = dg.Definitions(jobs=[sllaw_v2], schedules=[daily])
