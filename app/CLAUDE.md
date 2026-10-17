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

Imports go one way only. A package never imports one to its left.

```
apps/web → api → ai → services → db, etl_db
           api ────→ services
```

- **`db`**: the app's own database (`DATABASE_URL`): drizzle schema, client, and every query on it. Nothing
  else. Migrations: `pnpm --filter @sllaw/db generate` / `migrate`.
- **`etl_db`**: the corpus database the ETL publishes (`ETL_DATABASE_URL`): schema, client, queries.
  **Read-only, no migrations**: `etl.publish` owns these tables, truncates them each run, and a rebuild
  renumbers chunk ids. The app database stores `doc_key` + `label` + quote, never a chunk id alone, and no foreign
  key crosses the two databases.
- **`services`**: the business logic. Calls the queries in `db` and `etl_db`, never writes SQL or imports drizzle.
  Plain functions, so tRPC and the agents' tools call the same code.
- **`api`**: tRPC routers. Thin: input validation (zod), auth, then one service call. No logic, no queries.
- **`ai`**: model config (one model per task, via Cloudflare AI Gateway; `MODEL_<TASK>` env) and the agents.
  Agents' tools call `services`. Every LLM call goes through `model(task, workspaceId)`, and every embedding call lives here too (bge-m3,
  the model `etl/embed.py` used, so query and chunk vectors match): a search embeds in `ai`, then hands the
  vector to `services` → `etl_db` (Zilliz `chunks` is the corpus's vector store, so its client is in `etl_db`).
- **`apps/web`**: Next.js UI. Calls `api` only (tRPC), never services or databases.

Packages export TypeScript source (`exports: ./src/index.ts`); Next compiles them (`transpilePackages`), so
there is no build step per package. A new package goes in that list.
