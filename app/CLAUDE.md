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
                          → ai  (ports: services fills them when it runs an agent)
```

- **`db`**: the app's own database (`DATABASE_URL`): drizzle schema, client, and every query on it. Nothing else.
  Migrations: `pnpm --filter @sllaw/db generate` / `migrate`.
- **`etl_db`**: the corpus database the ETL publishes (`ETL_DATABASE_URL`, a separate database): schema, client,
  queries (and the vector search over Zilliz `chunks`, #16). **Read-only, no migrations**: `etl.publish` owns these
  tables, truncates them each run, and a rebuild renumbers chunk ids. The app database stores `doc_key` + `label` +
  quote, never a chunk id alone, and no foreign key crosses the two databases.
- **`services`**: the business logic. Calls the queries in `db` and `etl_db` and the models and agents in `ai`;
  never writes SQL or imports drizzle.
- **`ai`**: models and agents. LLMs (DeepSeek via Cloudflare AI Gateway, one model per task, `MODEL_<TASK>` env;
  every call goes through `model(task, workspaceId)`), embeddings (bge-m3, the model `etl/embed.py` used, so query
  and chunk vectors match), and the agents. **The one package with ports** (`src/ports.ts`): its agents' tools need
  search, read, links, as_of, which are services, while services calls ai; importing services would be a cycle. So
  ai declares those as interfaces and services passes its own functions in when it runs an agent. Imports no
  package of ours.
- **`api`**: tRPC routers, thin: input validation (zod), auth, one service call. No logic, no queries, no ai.
- **`apps/web`**: Next.js UI. Calls `api` only (tRPC).

Switching a technology (vector DB, embedding model, LLM, database) is a change inside its one package (`etl_db`,
`db`, `ai`); its exports stay the same.

Packages export TypeScript source (`exports: ./src/index.ts`); Next compiles them (`transpilePackages`), so
there is no build step per package. A new package goes in that list.
