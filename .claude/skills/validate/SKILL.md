---
name: validate
description: Run the semantic and security validators on the current branch's head commit before anything goes out (PR, merge, push to main, production deploy). Use when a feature is done, when the user says ship it / open a PR / merge / deploy, or when the release guard refuses for a missing validation.
---

# /validate

Unit tests and typecheck say the code runs. This says the feature is right and safe. The release guard
(`.claude/hooks/guard.py`, `release_gate`) refuses `gh pr create`, `gh pr merge`, `git push` to main and production
deploys until both reports for the exact head commit say `VERDICT: PASS`.

1. **Committed and green.** The change is committed on its branch (validation is of a commit; a later commit needs a
   new run). `pnpm check && pnpm typecheck && pnpm test` in `app/` and the etl tests pass.
2. **The brief.** `docs/features/<slug>.json` exists in status `agreed` (the user signed it off in /scope). If
   there is none, stop: scope it with the user first. A validator can only check what was agreed.
3. **App work: the dev server runs** from this worktree (`pnpm dev` in `app/`, in the background; wait for :3000).
4. **Run both validators in parallel**, each a fresh agent (`subagent_type: semantic-validator` and
   `security-validator`), each on the cheapest model the change needs (`model`: sonnet for most; opus for auth,
   access, money or a large diff; CLAUDE.md Rules), each given: the brief path, `base` = `git merge-base origin/main HEAD`, `head` = full
   `git rev-parse HEAD`, the worktree path, the dev URL, and its report path
   `$(git rev-parse --git-common-dir)/validation/<head>/{semantic,security}.md` (absolute; mkdir it first). Give them
   no opinion about whether it works.
5. **Read both reports.** On FAIL: fix, commit, go back to 1 (the new commit has no reports). A later round resumes
   the same two validators (SendMessage: the new head, `git diff <old> <new>`, the new report path) rather than
   spawning fresh ones: they keep what they checked and re-check what the diff touches (tokens, user 2026-11-11).
   A later round checks only what the new commits change (user, 2026-11-11): lines an earlier round passed stand
   unless the diff touches them; lines no round has checked yet are still checked once. Never edit a report or
   write one yourself; never argue a validator into a PASS. If a finding is wrong, say why to the user and let them
   decide.
6. **Tell the user** in a few lines: both verdicts, the problems found and fixed, what was not checked. Put the two
   reports' summaries in the PR description.
