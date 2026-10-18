# app — the sllaw app

Turborepo + pnpm. Product and decisions: `../docs/APP.md`. The corpus it answers from is built by `../etl/`.

```bash
pnpm install
pnpm dev          # apps/web on :3000
pnpm typecheck    # every package
pnpm build
```

Env: `.env.example` (one copy as `apps/web/.env.local`).

## Boundaries

A plain dependency tree; imports only go down it:

```
apps/web → api → services → db
                          → etl_db
                          → search
                          → ai  (ports: services fills them in ctx when it runs an agent)
```

- **`db`**: the app's own database (`DATABASE_URL`: database `app` in Neon sllaw-app, beside the corpus in `neondb`):
  drizzle schema, client, and every query on it. Nothing else.
  Migrations: `pnpm --filter @sllaw/db generate` / `migrate`.
- **`etl_db`**: the ETL's Neon only (`ETL_DATABASE_URL`, a separate database): schema, client, queries on `docs`,
  `chunks`, `links`. **Read-only, no migrations**: `etl.publish` owns these tables, truncates them each run, and a
  rebuild renumbers chunk ids. The app database stores `doc_key` + `label` + quote, never a chunk id alone, and no
  foreign key crosses the two databases.
- **`search`**: the vector DB (Zilliz now): law chunks (`chunks`, written by `etl/embed.py`) and user files
  (indexing and search, filtered by scope inside the query). It owns the query embedding (bge-m3, the model the
  index was built with): it takes text, not vectors. Changing the vector DB or the embedding model is a change here
  alone.
- **`services`**: the business logic. Calls the queries in `db`, `etl_db` and `search` and the agents in `ai`;
  never writes SQL or imports drizzle. Builds the `ctx` agents run with.
- **`ai`**: LLMs, tools and agents. DeepSeek via Vercel AI Gateway, one model per task (`MODEL_<TASK>` env);
  every call goes through `model(task, workspaceId)`. **The one package with ports** (`src/ports.ts`): its tools
  need search, read, links, as_of, which are services, while services calls ai; importing services would be a
  cycle. So everything an agent gets comes in one `ctx` (workspace, user, case, scopes, ports), built by services
  and already scoped to the request; tools (`tools/`) close over it, agents (`agents/`) take it. Imports no
  package of ours.
- **`api`**: tRPC routers, thin: input validation (zod), auth, one service call. No logic, no queries, no ai.
  Procedures by role: `signedUser`, `superAdmin`, `workspaceUser`, `workspaceAdmin`, `caseViewer`,
  `caseEditor`, `caseAuthor`, `chatViewer`, `chatOwner` (docs/APP.md, Access).
- **`apps/web`**: Next.js UI. Calls `api` only (tRPC).

Switching a technology (vector DB, embedding model, LLM, database) is a change inside its one package (`etl_db`,
`db`, `search`, `ai`); its exports stay the same.

Packages export TypeScript source (`exports: ./src/index.ts`); Next compiles them (`transpilePackages`), so
there is no build step per package. A new package goes in that list.
