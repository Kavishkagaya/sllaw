# app — the sllaw app

Turborepo + pnpm. Product and decisions: `../docs/APP.md`. The corpus it answers from is built by `../etl/`.

```bash
pnpm install
pnpm dev          # apps/web on :3000
pnpm typecheck    # every package
pnpm test         # unit tests (Vitest), every package; pnpm test:watch on change
pnpm build
```

Env: `pnpm env:pull` writes `apps/web/.env.local` from Vercel's Development variables (the dev database, dev
Clerk, R2 `sllaw-files`, the scoped Cloudflare tokens; `vercel link` in `app/` first). A new variable goes into Vercel
(Development, and Production with its production value) and `.env.example`. Plain `vercel env pull` in `app/` writes
`app/.env.local`, which nothing reads.

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
  whole file and returns its pages as JSON (`ocrFromEnv`: `mistralOcr` with `OCR_PROVIDER=mistral` + `MISTRAL_API_KEY`,
  else `httpOcr` when `OCR_URL` is set, else off); `NoText` when there is none.
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

Two services: the **file service** (`services/src/files`) is generic: a caller creates a file with the steps it needs
and the scopes it is found under (`Need`), and it stores it, runs those steps and reports their states. The **case
service** (`services/src/cases.ts`) checks the case, then creates the file with every step under `case:<id>`. The api
forwards: `case.addFile` / `file.startUpload` -> the browser PUTs to the signed URL -> `file.finishUpload` starts a
Vercel Workflow run (`files/workflow.ts`: one durable, retried step per pipeline; `withWorkflow` in `next.config.ts`;
its id in `files.run_id`).

Three pipelines on one `files` row (`services/src/files/pipeline.ts`), each behind its package's interface, joined
only by the row's step states and the file's folder in the store (`files/<id>/`): **extract** (original ->
`extract.json`; a scan goes to the OCR provider as a signed URL when one is set), then side by side **categorize** (->
`card.json`; `category` + `meta` on the row, the summary stays in the store) and **index** (-> `chunks.json` +
vectors under the row's `scopes`). `runStep` is the only writer of step state, for the workflow and the tests alike, and writes every state it sets to a `StateWriter`: in a workflow, the run's stream. A step's state is
null when the file does not need it (an asset: stored and done). No file content in Postgres.

Live status: `GET /api/files/<id>/events` (server-sent events: `snapshot`, `state`..., `end`) reads the run's stream.
The client keeps every upload in `apps/web/stores/upload-store.ts` (zustand, global: start, PUT with progress,
finish, follow); `components/upload-tray.tsx` shows them on every page, `useFileStatus(fileId, initial)` on a page.

Errors are retryable or not (`services/src/files/errors.ts`, the one rule): network errors, timeouts, 408/425/429/5xx
and unknown errors are retried by the workflow (3 attempts); a file its parser cannot read (extract's `Unreadable`)
and other 4xx fail at once. A step's error is `{ message, retryable }` on the row, and the UI offers "Try again" only
when it can help. No sweep or cron: a step whose function was cut off is retried by its run, which claims it back at
once; `file.reprocess` reruns retryable failures and steps a stopped run left open.
**Busy** (db `files.ts`, one SQL rule): a step running, extract pending, or categorize/index pending after extract
is done, within 15 minutes of the row's last write. While busy, delete is refused (CONFLICT) and reprocess starts
no second run. Delete marks the row `deleting` first (no run claims it), then removes vectors, blobs, row. A claim
makes its run the file's owner (`run_id`); a step's end is written only by its owner.
**Step timeouts** (`STEP_TIMEOUT`, pipeline.ts): extract 240 s, categorize 90 s, index 180 s, under Vercel's 300 s
function limit. `runStep` aborts the step's signal (passed to OCR, the model, embedding and Zilliz calls) and records
a retryable `StepTimeout`: 3 attempts, then failed with "Try again". Raise them only with the function's maxDuration. `<step>_by` records what produced each output, so files done by an older version can be found.

## Tests

Vitest (`vitest.config.mts`): `*.test.ts` beside the code in `packages/*/src`, in memory only (no database, R2, model
or Zilliz), run by `pnpm test`. The file pipelines: `services/src/files/{pipeline,errors}.test.ts`,
`extract/src/extract.test.ts`, `search/src/chunk.test.ts`. Checks against real services stay scripts, run on
purpose: `services check-accounts` (dev database), `services eval-chat` and `search eval` (model and Zilliz, cost).
