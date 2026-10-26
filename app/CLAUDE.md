# app — the sllaw app

Turborepo + pnpm. Product and decisions: `../docs/APP.md`. The corpus it answers from is built by `../etl/`.

```bash
pnpm install
pnpm dev          # apps/web on :3000
pnpm typecheck    # every package
pnpm check        # Biome: lint + format + import order (biome.json); `pnpm fix` applies safe fixes
pnpm build
```

Env: `.env.example` (one copy as `apps/web/.env.local`).

## Boundaries

A plain dependency tree; imports only go down it:

```
apps/web → api → services → db
                          → etl_db
                          → search
                          → storage
                          → extract
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
  (`FileIndex`: the Zilliz `files` collection, `pnpm --filter @sllaw/search files-collection` creates it; chunking;
  filtered by workspace and scope inside the query; a doc_type filter is resolved to file ids in Postgres). It owns the query embedding (bge-m3, the model the
  index was built with): it takes text, not vectors. Changing the vector DB or the embedding model is a change here
  alone.
- **`storage`**: the blob store (`BlobStore`: put, get, head, deletePrefix, signed upload/download URLs). R2 (the
  `R2_FILES_BUCKET`, apart from the ETL's bucket) or memory (`STORAGE=memory`, tests and local runs).
- **`extract`**: a file's bytes -> its text, page by page. One `Extractor` per format (unpdf for text-layer PDFs,
  mammoth for .docx, plain text and HTML); OCR through an `OcrProvider`: the endpoint gets a signed URL to the
  whole file and returns its pages as JSON (`httpOcr`, on when `OCR_URL` is set); `NoText` when there is none.
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

## Files

Three pipelines on one `files` row (`services/src/files/pipeline.ts`), each behind its package's interface, joined
only by the row's step states and the file's folder in the store (`files/<id>/`): **extract** (original ->
`extract.json`; a scan goes to the OCR endpoint as a signed URL when `OCR_URL` is set), then side by side **categorize** (->
`card.json`; `category` + `meta` on the row, the summary stays in the store) and **index** (-> `chunks.json` +
vectors). Upload comes before: `file.startUpload` -> the browser PUTs to the signed URL -> `file.finishUpload`
starts a Vercel Workflow run (`files/workflow.ts`: one durable, retried step per pipeline; `withWorkflow` in
`next.config.ts`). `runStep` is the only writer of step state, for the workflow, the sweep and the tests alike. A
step's state is null when the file does not need it (an asset: stored and done). No file content in Postgres.
`<step>_by` records what produced each output, so `pnpm --filter @sllaw/services files-sweep --stale <step>` redoes
the files an older version did; without `--stale` it picks up files left unfinished. Tests:
`pnpm --filter @sllaw/services test-files` (all in memory).
