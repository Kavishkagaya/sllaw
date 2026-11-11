---
name: scope
description: Scope a new feature, fix or ETL change with the user before any code is written - an interview in rounds that ends in an agreed brief (docs/features/<slug>.json) and a GitHub issue. Use whenever the user asks for something to be built or changed ("let's make onboarding", "fix X", "add Y"), and when the guard refuses a code edit for a missing scope.
---

# /scope

The user is learning the scope while you talk, so this is a conversation, not a form. No code until the brief is
agreed (the guard refuses code edits under `app/` and `etl/` without one).

1. **Read first, so you only ask what the repo can't answer:** `docs/APP.md` (who the app is for, decisions
   already made), `docs/features/` (related briefs), the code the change touches, and open issues
   (`gh issue list`). Note what is already decided; don't ask it again.
2. **Interview in rounds** (AskUserQuestion, at most 4 questions a round, each with options and a recommended
   one first; plain chat for open questions). Round by round, go from the outside in:
   - **Who and why:** who uses it, what they're trying to get done, what happens today without it.
   - **What they must see:** the main path step by step; what the first result looks like.
   - **Edges and limits:** what's out of scope for now, costs (model calls, plan limits), languages, phone.
   - **Done:** propose the done-check lines yourself (observable: steps, numbers, an eval) and let them correct.
   After each round, say back in two or three lines what you now understand, so they can see the scope forming.
   Stop when the user has nothing to change, not when you run out of questions. A bug fix may need one round.
3. **Write the brief** `docs/features/<slug>.json` in status `scoping` (shape: `docs/features/README.md`; size it to
   the work). Branch: `app/<slug>` for app work, `main` for ETL. Show the user a short summary: goal, done-check,
   scenarios, out of scope.
4. **Sign-off:** set `status` to `agreed`. The guard asks the user on a permission prompt; their yes is the
   agreement. A no means another round.
5. **Issue and branch:** `gh issue create` with the summary (title = brief title, body = goal, done-check,
   scenarios, out of scope, a link to the brief path); put the number in `issue` and a first `progress` line. For app
   work: `git checkout -b app/<slug> origin/main` here in the main checkout (no worktree, user 2026-11-11);
   `pnpm install` if the lockfile changed. Then its database (ids in `.claude/agent-db.json`): Neon `create_branch` named `agent/<slug>` in project
   `sllaw-app` from main (name only: the free plan refuses compute settings, 2026-11-10); `get_connection_string` for that branch,
   database `app`, the same role as the main URL; copy `app/apps/web/.env.local` to `.env.main`
   (the production one, put back at merge) and write the branch URL as its `DATABASE_URL`, every other variable
   unchanged. Never print the URL.
   Record `neon_branch` {name, id} in the brief. ETL work skips this.
6. Tell the user it's agreed and that `/build` takes it from here.
