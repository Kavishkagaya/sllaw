# Feature briefs

One JSON file per piece of work, `docs/features/<slug>.json`: what the user asked, how we both know it is done,
and the log of the work. Written by `/scope` with the user, built by `/build`, checked by `/validate`, kept after
it ships. JSON, not Markdown, because agents are less likely to rewrite a JSON file they should only append to
(Anthropic, "Effective harnesses for long-running agents", 2025-11).

```json
{
  "title": "Onboarding",
  "slug": "onboarding",
  "status": "scoping",
  "branch": "app/onboarding",
  "issue": null,
  "neon_branch": {"name": "agent/onboarding", "id": "br-..."},
  "goal": "What the user asked, in their words.",
  "for_whom": "A practising lawyer signing up for the first time.",
  "done_check": [
    {"id": "d1", "check": "A new user reaches a cited answer in their first case in 3 steps or fewer."}
  ],
  "scenarios": [
    {"id": "s1", "steps": "Sign up, pick role and courts, create a case with two lines of facts.",
     "expect": "Lands in the case; the first answer cites sections that open in the viewer."}
  ],
  "out_of_scope": ["Bar number verification."],
  "decisions": [{"date": "2026-11-10", "note": "Practice areas are a fixed list, not free text (user)."}],
  "progress": [{"date": "2026-11-10", "note": "Scoped with the user; issue #45."}]
}
```

**Status:** `scoping` → `agreed` (the user's yes on the permission prompt is the sign-off) → `merged`, or
`dropped`. The guard (`.claude/hooks/guard.py`) enforces it: a new brief starts in `scoping`; once agreed,
`goal`, `for_whom`, `done_check`, `scenarios` and `out_of_scope` are frozen (changing them means asking the user and
reopening to `scoping`); code under `app/` and `etl/` can be edited only on the branch of an agreed brief.
`decisions` and `progress` are append-only by convention: one dated line per session or choice.

**`neon_branch`** (app work): the brief's own branch of the app database (Neon `sllaw-app`, from `main`), made in
/scope, deleted at merge or drop and set back to `null`; a session start lists any left over. The worktree's
`app/apps/web/.env.local` points `DATABASE_URL` at it; the guard refuses running the app, evals or migrations
from a brief worktree that points at production. ETL work has none (`null`).

**Size it to the work** (Fowler on spec tools: a bug fix turned into 16 acceptance criteria is overkill). A bug fix
is one done-check and one scenario; a feature has a few of each. ETL work uses `"branch": "main"`.
