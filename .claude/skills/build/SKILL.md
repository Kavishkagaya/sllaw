---
name: build
description: Build an agreed brief (docs/features/<slug>.json) to the end without asking about the how - session routine, one done-check at a time, commits on the brief's branch, /validate, PR, and rebase-merge when both validators pass. Use after /scope, when the user says "build it" or "continue", or when a session starts with open agreed work.
---

# /build

The scope is agreed and frozen; your job is the how. Don't ask the user about method. Ask only if the brief turns
out to be wrong or impossible: then stop, explain, and reopen it with them (/scope), never work around it.

**Session start** (every time, also when continuing):
1. In `~/sllaw` (no worktree), `git checkout` the brief's branch (main for ETL); read the brief, its `progress`, `git log --oneline -15`.
2. Run the checks (`pnpm check && pnpm typecheck && pnpm test` in `app/`; etl tests). If they fail, fix that first.
3. For app work, `pnpm dev` in the background and one quick look at the core path (sign in, open a case), so you
   don't build on something already broken.

**Loop**, one done-check (or scenario) at a time:
1. Build it in the smallest slice that can be checked. Follow `app/CLAUDE.md` boundaries.
2. Check it yourself the way the validator will: run the scenario in the headed browser, run the eval, read the
   numbers. Add unit tests for the logic.
3. Commit on the brief's branch (the commit guard runs the checks). Append one `progress` line: what is done, what is
   next. Record choices in `decisions` (and `docs/APP.md` if they bind future work).

**Finish:**
1. Everything in `done_check` and `scenarios` works by your own check → `/validate`.
2. A FAIL: fix, commit, validate again. **At most 3 validation rounds**; after the third FAIL, stop and report to
   the user what keeps failing (bounded like Stripe's two CI rounds: past that, more tries rarely help).
3. **Schema change?** Migrations ran freely on the brief's Neon branch. Before the merge, run the same migration
   on production (on main, with `.env.main` put back as `.env.local`: `pnpm --filter @sllaw/db migrate`): the guard asks the user, and their yes
   is required (production is the app's one database and the merge deploys at once). A no: the PR waits; say so.
4. Both PASS: `git push -u origin <branch>`, `gh pr create` (body: the brief summary, both reports' verdicts and
   findings, "Closes #<issue>"), then `gh pr merge <n> --rebase --match-head-commit <sha>` (the user allows merging
   validated work, 2026-11-10). Vercel deploys main. ETL on main: push to main once validated, then the run.
5. Delete the brief's Neon branch (`delete_branch` with `neon_branch.id`; the user allows deleting agent branches,
   2026-11-10), set `neon_branch` to null. Same when a brief is dropped.
6. On main: set the brief's `status` to `merged` with a last `progress` line, commit, push (docs-only, no gate).
   Move `app/apps/web/.env.main` back to `.env.local` (production). Tell the user in a few lines: what shipped, the PR link, what the validators flagged,
   anything not checked.
