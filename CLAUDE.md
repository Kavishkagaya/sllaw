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
  `sllaw-app` (ids in `.claude/agent-db.json`); while on the brief's branch, `app/apps/web/.env.local` points at it
  (the production one is kept as `.env.main`, put back at merge), and it is deleted at merge or drop. A checkout on a
  brief's branch pointing at production can't run the app, evals or migrations. The user may skip it for a brief
  (`"neon_branch": false`, e.g. UI-only, user 2026-11-15): setting it asks the user, and only an agreed brief's
  branch then runs the app on main; migrations still can't. *Guarded.*
- **Branches** (2026-10-06, 2026-10-26): ETL work commits on `main`; app features on their brief's branch off
  `origin/main`, checked out here in `~/sllaw`, never a separate worktree (user, 2026-11-11). Commits on the brief's branch are part of /build; outside the loop, commit only when
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
- **Seeing comes before agreeing** (user, 2026-11-14): for work the user judges by eye (a page's look or motion), /scope
  offers a preview before sign-off: `"preview": true` on the scoping brief (asks the user) opens its branch for
  edits; the preview runs locally, uncommitted, and the user agrees or reshapes the scope from what they saw. *Guarded.*
- **Unrelated work during a task goes to a subagent**, so the main thread stays on the task (2026-10-10); **every subagent runs on the cheapest model that can do its job** (user, 2026-11-11):
  chosen per spawn for that job (no agent definition pins one): haiku for search, reading and summaries, sonnet for
  ordinary code and most validation, opus only for hard judgement. *Guarded: every spawn but a fork names `model`.*
- **Spend Claude Code tokens like money** (user, 2026-11-11, after a session hit its 5-hour limit): read a page with a
  targeted `agent-browser eval` or a grepped snapshot, never a whole snapshot; screenshot only to judge a design;
  wait with one quiet loop that prints only the end state; a later validation round resumes the same validators
  (SendMessage with the new head and the diff) instead of spawning fresh ones; demos and repeat runs only when asked. Paid evals (eval-agent, eval-chat) too
  (user, 2026-11-17, after ~$1.30 of reruns in one build): one run per side the brief asks for; a rerun to judge
  noise, or a full run after a prompt tweak, is proposed with its cost and waits for a yes.
  No agent redoes another's work (user, 2026-11-12, 2026-11-14): validators verify the builder's recorded runs (the
  brief's `progress`, the rows it left, its UI walk with screenshot paths) instead of re-running paid steps or
  re-walking the UI, walk only what the record does not cover, and each validator stays in its own lane.
- **Walk a preview before handing it over** (user, 2026-11-15): after a UI change, open it in the headed browser and
  check each changed thing as a lawyer would (click it, read the result with a targeted eval) before telling the user
  it is ready; "typecheck passes" is not "it works". The user looks second, not first. Walk every kind of case the
  view can show, not one example (a law citation: an amended section, an amending section, a never-amended one; 2026-11-15).
  A dependency patch bump is not a UI change: checks, a production build and the pages loading are its check, no walk
  (user, 2026-11-17).
- **Only the streaming message renders** (user, 2026-11-15): earlier messages in a chat get stable props (memo on their
  parts, no `animated`/`isAnimating`) and never re-render while an answer streams; data the chips read through context
  keeps its identity until it changes. A per-token re-render of the thread made stalls grow with chat length.
- **A watch command shows live progress, and is run once before it is handed over** (user, 2026-11-16, after
  `tail -f all.log` and `tmux attach` both showed nothing between steps): counts that move (done / running / todo /
  failed) every few seconds, e.g. `bash ~/sllaw/logs/v2/watch.sh <log dir>` on ampere for a plan/work run.
- **Test the app the way a lawyer talks** (user, 2026-11-11): plain questions about the case and its people
  ("the Perera Traders demand"), never file names, ids or our own terms ("card", "field", "fileEdit"), and no
  invented facts that contradict the documents just to provoke the agent.
- **An eval miss is diagnosed before it is reported** (user, 2026-11-17): read what the agent cited or returned
  instead and say whether the question (its gold) or the agent is wrong. A wrong question is rewritten (a note in the
  case says why), not put to the user as a choice of target; only an agent that falls short goes to the user.
- **YAGNI, simplest version** (user, 2026-11-11, 2026-11-12): scope and build only what the user asked for; no
  undo, history or other "just in case" extras (they come back when a user asks). The smallest change that works:
  one line where one line does it, not a new module, option or abstraction. One path for one kind of thing: a model
  call is a model call wherever it starts (metered, priced and checked the same way), no per-caller special case.
- **Shared UI state lives in a zustand store** (`apps/web/stores/`, user 2026-11-15): state another component reads
  or that must survive leaving the page (a chat's draft, playbook, open citation; uploads) goes in a store, keyed per
  chat or upload; a menu's open, a hover or a form being typed stays in `useState`.
- **The pipeline fetches a source from its own site** (user, 2026-11-16): a mirror, an archive or anyone's copy
  (Wayback, a GitHub dataset) used to fill a backlog goes in a one-off backfill script run by hand
  (`etl/v2/backfill.py`), never into a spider, the fetch rank or the downloader, so the nightly run knows only the
  real sites.
- **Prices and vendor facts come from the docs or the web, never memory** (user, 2026-11-16, after OCR prices were
  quoted wrong): read what `docs/` already records (OCR: `docs/APP.md`), check anything older on the web, cite sources.
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
  assets), `all.sh` (the whole chain with no engine), `schema.sql`, `test_v2.py`, `judgment.py` (judgments' own
  stages 4-5), `backfill.py` (the one-time judgment backfill, 2026-11-16). Plan and decisions:
  `docs/PIPELINE_V2.md`; links model: `docs/LINKS.md`.
- `etl/*.py`: v1 modules v2 still imports (`structure.blocks()`, spiders, `refs`, `mentions`, `extract`).
  `publish.py`, `embed.py`, `docs.py` builds and ampere's local Postgres are **retired** (2026-11-08).
- `etl/overrides.json`: human fixes the gate reads (accepted issues, rejected files). `etl/gold_links.json` (210
  hand-labelled links), `etl/eval_*.json`: the evals.
- `app/`: Turborepo, Next.js + tRPC + packages. Its own map: `app/CLAUDE.md`. Product: `docs/APP.md`.
- `docs/`: `SOURCES.md` (every site, coverage, blockers), `PIPELINE_V2.md` (now), `PIPELINE.md` (v1 decisions and
  measurements, v1 operations at the end), `LINKS.md`, `LAYOUT.md` (how Act PDFs are laid out), `APP.md`.

Keys: Acts `act:N/YYYY`, Laws `law:N/YYYY`, chapters `cap:N` (1980) and `cap1956:N`, `constitution`, `amendment:N`,
`gazette:NNNN/NN`, judgments `ca:<file>` / `sc:<file>` (the court's PDF name, lower case, no .pdf; over 64 chars, trimmed with 8 hex of
the name, the Zilliz `doc_key` limit). Structuring is code-based and English-only; Sinhala and Tamil go to an agent with the whole Act.

### Hosts

Department servers, LDAP user `e19309`, reached through tesla (`ssh ampere` etc. in `~/.ssh/config`; no key on the laptop, so
log in by password with pexpect as `/ada-ssh` shows, 2026-11-12). `~/sllaw` is the shared NFS home (slow: run Python from `/var/tmp/e19309/*_venv`, never `~/sllaw/.venv`);
`/var/tmp/e19309` is per host and survives reboots, `/tmp` does not. Its git checkout is stale (most files
untracked, `git pull` refuses, 2026-11-12): code gets there by copying changed files (check first that the remote
copy matches the base commit), then `bash etl/v2/dagster.sh` with no run active. Skill: `/ada-ssh`.

- **ampere** 10.40.18.10: the work host. 2× RTX A6000 48 GB, shared and busy. Venvs `etl_venv`, `sllaw_venv`
  (docling), `gpu_venv` (bge-m3), `lighton_venv` (vLLM), `dagster_venv`; env in `/var/tmp/e19309/neon.env` (V2_*; there is no v2.env, 2026-11-16).
  Dagster UI: `ssh -L 3070:localhost:3070 ampere`. After a reboot: `bash ~/sllaw/etl/v2/dagster.sh`.
- **ada** 10.40.18.12: 3× RTX 6000 Ada, extra GPUs when ampere is full (has no bge-m3 or gpu_venv). Its `pgdata`
  is stale: never start it.
- turing .3 (RTX 3090 Ti, crowded), tesla .7 (jump host, no GPU), kepler .9 (K40c, too old).

## Checks

```bash
cd app && pnpm check && pnpm typecheck && pnpm test           # app: biome, tsc, vitest (in memory, ~15 s)
.venv/bin/python3 -m etl.test_structure                       # also etl.test_refs, etl.test_mentions, etl.v2.test_v2
python3 .claude/hooks/test_guard.py                           # the guards (78 cases)
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
- **docling takes cuda:0 unless told** (2026-11-16: card 0 full, 203 of 559 extracts failed out of memory): the
  extract op and any hand-run `work extract` set `CUDA_VISIBLE_DEVICES` to the freest card.
- **transformers 5.x breaks surya** (`SuryaDecoderConfig` lacks `pad_token_id`): pin 4.57.6 and add
  `kwargs.setdefault("pad_token_id", 2)` before `super().__init__()` in `surya/common/surya/decoder/config.py`.
  Surya on CPU gives 1 box a page: GPU only.
- **vLLM (LightOn) on ampere**: uninstall torchcodec (CUDA 13 build); `/var/tmp/e19309/cache` must exist on each
  host; set `VLLM_USE_FLASHINFER_SAMPLER=0` inside the tmux command. `etl/lighton_setup.sh` and `etl/ocr_ada.sh` do
  all three.
- **DNS on the department hosts drops for a minute or so**: connect with `etl.fetch.pg_connect()`, which retries.
- **Neon closes a connection left idle** (embed's mark after hours, 2026-11-08; a listing's crawl after minutes,
  2026-11-12): open the connection after the long step, with `pg_connect()`. Dagster ops also retry twice.
- **Tmux sessions and Dagster do not survive a reboot**: rerun `etl/v2/dagster.sh` on ampere.
- **Node can't reach Neon on a slow network** (2026-11-11, this laptop): IPv6 is unreachable and an IPv4 connect
  takes 1-3 s, past Node's 250 ms per address, so every query is `fetch failed` (AggregateError, ETIMEDOUT) while
  curl works. `apps/web`'s `dev` script sets `--network-family-autoselection-attempt-timeout=3000`; use the same
  `NODE_OPTIONS` for scripts.
- **`pkill -f "next dev"` kills its own shell** (its command line matches, exit 144, the rest of the command never
  runs; 2026-11-15): use `pkill -f "[n]ext dev"`.
- **Streamdown redraws every block when a renderer's identity changes** (2026-11-15): a `components` object rebuilt
  per streamed chunk restarted the word fade on every word. Pass one module-level `components`; chat data the
  renderers need comes through a context (`CiteInfo` in `components/chat/chat.tsx`).
- **`:target` never matches after a Next `Link` navigation** (pushState sets no target, 2026-11-15): mark and scroll to
  a `#hash` in an effect (`/doc`'s `DocView` sets `data-cited`).
- **`next build` fails on `/_global-error` ("reading 'useContext'")** when the shell has `NODE_ENV=development`
  (this laptop does, 2026-11-17): build with `NODE_ENV=production`.
- **`run work <stage> --n N` is the claim batch, not N workers** (2026-11-17: a hand-run `--n 8` relink of 3,481
  gazettes was one sequential worker, ~39 a minute at 10% CPU): start several processes with `--n 2`, as `all.sh` and
  Dagster do, then `resolve` once every worker has exited.
- **Legacy-font Sinhala listed as English** (act:54/2007, act:7/2006): nothing flags it yet.
