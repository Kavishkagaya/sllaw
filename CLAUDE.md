# sllaw — Sri Lanka Law

A corpus of Sri Lankan law (Constitution, Acts, Laws, Revised Editions, gazettes; judgments next) and an app that
answers lawyers from it. This file is the map of how things are **now**. History lives in `docs/` and git.

## How we work: the garden

The user is the farmer: they say **what to grow** (the goal) and set **the environment** (limits, costs, rules,
taste). The agent grows it: it chooses **how**, does the work, and shows it has grown.

Every piece of work runs one loop. The user is in the first step; the rest runs without them, while they are here
(no auto triggers, user 2026-11-10). GitHub issues and PRs are the trail.

1. **`/scope` — together.** Scope with the user before any code (user, 2026-11-10): they learn the scope while you
   talk, so it's an interview in rounds (who it's for, what they must see, what's out, what "done" looks like),
   with options and a recommendation, until they have nothing to change. Size it to the work: a bug fix is one
   done-check, not sixteen. It ends in a brief, `docs/features/<slug>.json` (shape in its README), agreed on a
   permission prompt, and a GitHub issue. *Guarded: code under `app/` and `etl/` can't be edited without an agreed
   brief for the branch, and an agreed scope is frozen.*
2. **`/build` — alone.** The how is yours: choose the method, say which and why in one line, go. Each session starts
   by reading the brief's `progress` and `git log` and running the checks; work one done-check at a time, commit on
   the brief's branch, append a `progress` line. If the brief turns out wrong, stop and reopen it with the user.
3. **`/validate` — two fresh agents** on the head commit, because code tests prove the code runs, not that the
   feature is right: `semantic-validator` (the brief's done-checks and scenarios, used as a lawyer would, citations
   read for substance) and `security-validator` (access, secrets, prompt injection, cost). Both must PASS; the
   builder never writes their reports. At most 3 rounds, then stop and report.
4. **Ship.** PR (brief, verdicts, "Closes #N"), then rebase-merge: the user allows merging validated work
   (2026-11-10). Brief to `merged`, a few lines to the user: what shipped, the link, what was flagged.

- **The environment is code before prose.** A rule a machine can check is a guard (`.claude/hooks/guard.py`) or a
  test, not a sentence. Prose rules (below) are for what no machine can check.

### When something goes wrong

A correction from the user is a change to the environment, so it never happens twice. In the same turn:
1. Fix what went wrong.
2. Close the loop: a guard in `.claude/hooks/guard.py` (with a case in `test_guard.py`) if a machine can check it,
   else one dated line under **Rules** below. Update a rule that is already there instead of adding a second one.
3. Tell the user in one line what changed ("added a guard: `gh pr merge` without `--rebase` is refused").

The same goes for a mistake the agent finds itself: a failed run, a wrong number, a stale line in this file. Fix the
map when it is wrong; a stale map is how agents go wrong here. Personal facts and secrets (logins, people) go in the
agent's private memory, never here.

## Rules

Each came from a correction or a costly mistake. Guarded = `.claude/hooks/guard.py` refuses it or asks first.

- **No downloads to this machine**, not even samples (2026-10-04); heavy work runs on ampere. **No model, weights or
  package download anywhere without the user's yes**, saying size and time (2026-10-09). *Guarded (asks).*
- **Shared hosts store nothing:** stream R2 → memory → R2/Neon, pipe probe scripts over ssh, delete temp files
  (2026-10-05). `/var/tmp/e19309` holds only infrastructure (venvs, models, Dagster home).
- **GPU work takes the freest card**, checked with `nvidia-smi` at start, never hard-coded (2026-10-06).
- **Neon egress is metered** (quota hit 2026-10-10): never bulk-read doc or chunk text out of Neon (text is in R2
  anyway); joins stay inside the database; small rows only. ETL inspection never touches the app's database
  (2026-10-16). *Guarded (asks on Neon SQL).*
- **Full rebuilds cost money** (2026-10-10): test a rule change in memory first, read the result, then build only
  what changed. Say up front when a step needs a full rebuild.
- **Production writes need a yes:** `etl.v2.run ... --apply` (kb, Zilliz, R2), app migrations on the main database
  (dev and production are one database, 2026-11-03), force pushes. *Guarded (asks).*
- **Agents test on their own database** (2026-11-10): each app brief gets a Neon branch `agent/<slug>` of
  `sllaw-app` (ids in `.claude/agent-db.json`), its worktree's `.env.local` points at it, and it is deleted at merge
  or drop. A brief worktree pointing at production can't run the app, evals or migrations. *Guarded.*
- **Branches** (2026-10-06, 2026-10-26): ETL work commits on `main`; app features on their brief's branch off
  `origin/main`, in a worktree. Commits on the brief's branch are part of /build; outside the loop, commit only when
  asked (2026-11-10).
- **PRs merge with `gh pr merge <n> --rebase`**, never a merge commit or squash (2026-10-26). *Guarded.*
- **A fix goes into the commit it fixes** (user, 2026-11-11): `git commit --fixup=<sha>` then
  `git rebase -i --autosquash`, never a separate "fix" commit; the brief's branch is then force-pushed with
  `--force-with-lease` (never `main`).
- **A commit passes the checks:** app (biome on staged files, typecheck, unit tests), etl (the four local test
  suites). *Guarded: a failing commit is refused with the output.*
- **Release gate** (2026-11-10): `gh pr create`, `gh pr merge` (with `--match-head-commit <sha>`), `git push` to
  main and `vercel --prod` need `VERDICT: PASS` from both validators for that exact commit, in
  `<git-common-dir>/validation/<sha>/`; changes only to `docs/` or `*.md` pass. *Guarded.*
- **Browser tests run headed** (`agent-browser --headed`); the user watches (2026-10-27). *Guarded.*
- **Unrelated work during a task goes to a subagent**, so the main thread stays on the task (2026-10-10).
- **Spend Claude Code tokens like money** (user, 2026-11-11, after a session hit its 5-hour limit): read a page with a
  targeted `agent-browser eval` or a grepped snapshot, never a whole snapshot; screenshot only to judge a design;
  wait with one quiet loop that prints only the end state; a later validation round resumes the same validators
  (SendMessage with the new head and the diff) instead of spawning fresh ones; demos and repeat runs only when asked.
- **Never repeat an investigation:** read `docs/SOURCES.md` before probing a site, `docs/PIPELINE_V2.md` before
  changing the pipeline. Findings get written down in the same session (see "Writing things down").

## The map (2026-11-10)

```
sources ──► Pipeline v2 (etl/v2, Dagster on ampere, daily 02:00 Colombo)
            state: Neon sllaw-etl (db/role etl)   bytes: R2 bucket sllaw (files, raw, tree/, app/law/ text parts)
            publish ─► schema kb in sllaw-etl ◄── the app reads it (role app_reader, read-only; text from R2)
            embed   ─► Zilliz `chunks` (bge-m3, run locally on ampere's freest GPU)
app (app/, Vercel) ─► its own database `app` in Neon sllaw-app (dev and production are the same database)
```

- `etl/v2/`: the pipeline. `run.py` (listing / plan / work / resolve / status / publish / embed), `gate.py` (the
  quality gate), `pipeline.py` (Dagster
  assets), `all.sh` (the whole chain with no engine), `schema.sql`, `test_v2.py`. Plan and decisions:
  `docs/PIPELINE_V2.md`; links model: `docs/LINKS.md`.
- `etl/*.py`: v1 modules v2 still imports (`structure.blocks()`, spiders, `refs`, `mentions`, `extract`).
  `publish.py`, `embed.py`, `docs.py` builds and ampere's local Postgres are **retired** (2026-11-08).
- `etl/overrides.json`: human fixes the gate reads (accepted issues, rejected files). `etl/gold_links.json` (210
  hand-labelled links), `etl/eval_*.json`: the evals.
- `app/`: Turborepo, Next.js + tRPC + packages. Its own map: `app/CLAUDE.md`. Product: `docs/APP.md`.
- `docs/`: `SOURCES.md` (every site, coverage, blockers), `PIPELINE_V2.md` (now), `PIPELINE.md` (v1 decisions and
  measurements, v1 operations at the end), `LINKS.md`, `LAYOUT.md` (how Act PDFs are laid out), `APP.md`.

Keys: Acts `act:N/YYYY`, Laws `law:N/YYYY`, chapters `cap:N` (1980) and `cap1956:N`, `constitution`, `amendment:N`,
`gazette:NNNN/NN`. Structuring is code-based and English-only; Sinhala and Tamil go to an agent with the whole Act.

### Hosts

Department servers, LDAP user `e19309`, reached through tesla (`ssh -J tesla e19309@<ip>`; `ssh ampere` is set
up). `~/sllaw` is the shared NFS home (slow: run Python from `/var/tmp/e19309/*_venv`, never `~/sllaw/.venv`);
`/var/tmp/e19309` is per host and survives reboots, `/tmp` does not. Skill: `/ada-ssh`.

- **ampere** 10.40.18.10: the work host. 2× RTX A6000 48 GB, shared and busy. Venvs `etl_venv`, `sllaw_venv`
  (docling), `gpu_venv` (bge-m3), `lighton_venv` (vLLM), `dagster_venv`; env in `/var/tmp/e19309/{neon,v2}.env`.
  Dagster UI: `ssh -L 3070:localhost:3070 ampere`. After a reboot: `bash ~/sllaw/etl/v2/dagster.sh`.
- **ada** 10.40.18.12: 3× RTX 6000 Ada, extra GPUs when ampere is full (has no bge-m3 or gpu_venv). Its `pgdata`
  is stale: never start it.
- turing .3 (RTX 3090 Ti, crowded), tesla .7 (jump host, no GPU), kepler .9 (K40c, too old).

## Checks

```bash
cd app && pnpm check && pnpm typecheck && pnpm test           # app: biome, tsc, vitest (in memory, ~15 s)
.venv/bin/python3 -m etl.test_structure                       # also etl.test_refs, etl.test_mentions, etl.v2.test_v2
python3 .claude/hooks/test_guard.py                           # the guards (69 cases)
```

On ampere, against real data (on purpose, they cost): `python -m etl.v2.gate --workers 8` (quality gate),
`python -m etl.v2.run gold-links` (210/210); in `app/`: `pnpm --filter @sllaw/services eval-chat` / `eval-agent`,
`pnpm --filter @sllaw/search eval`.

## Writing things down

Investigations are expensive; never run one twice. Whatever a session finds or decides that is not obvious from
the code goes in the same session to: sources → `docs/SOURCES.md` (in that source's row); scope → its Scope
section with the reason; pipeline decisions and measurements → `docs/PIPELINE_V2.md`; PDF layout → `docs/LAYOUT.md`;
app decisions → `docs/APP.md`; a fix for a known issue → "Known issues" below.
Date every finding (`2026-11-10`), give numbers not adjectives, update a row instead of adding a contradicting
one, and record dead ends and what was *not* checked.

## Known issues

- **docling `max_num_pages` marks a PDF invalid**: use `page_range=(1, N)`.
- **docling `PARTIAL_SUCCESS` drops pages** (15/1991 kept 1 of 7): `etl/extract.py` raises so the row stays
  queued; never store a partial raw.
- **docling's default backend** keeps word cells and fonts (2.104); `etl/extract.py` falls back to pypdfium per file.
- **transformers 5.x breaks surya** (`SuryaDecoderConfig` lacks `pad_token_id`): pin 4.57.6 and add
  `kwargs.setdefault("pad_token_id", 2)` before `super().__init__()` in `surya/common/surya/decoder/config.py`.
  Surya on CPU gives 1 box a page: GPU only.
- **vLLM (LightOn) on ampere**: uninstall torchcodec (CUDA 13 build); `/var/tmp/e19309/cache` must exist on each
  host; set `VLLM_USE_FLASHINFER_SAMPLER=0` inside the tmux command. `etl/lighton_setup.sh` and `etl/ocr_ada.sh` do
  all three.
- **DNS on the department hosts drops for a minute or so**: connect with `etl.fetch.pg_connect()`, which retries.
- **Neon closes a connection left idle for hours** (embed's mark, 2026-11-08): open a fresh one after a long step.
- **Tmux sessions and Dagster do not survive a reboot**: rerun `etl/v2/dagster.sh` on ampere.
- **Legacy-font Sinhala listed as English** (act:54/2007, act:7/2006): nothing flags it yet.
