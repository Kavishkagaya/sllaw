# App

Product plan, agreed 2026-10-15 (user). The ETL corpus (docs, chunks, links) is what the app answers from.

## Who and why

Individual Sri Lankan lawyers first (then juniors and law students). ChatGPT doesn't know Sri Lankan law or which
version of a section is in force; lankalaw is a document store. We hold the full statute corpus with its amendment
graph and work inside the lawyer's case.

Release only after the ETL is done: legislation, judgments and regulations (epic #1). Lawyers argue from judgments
as much as from sections.

## Product

**Onboarding** (2–3 minutes, ends inside the first case): role; practice areas and courts; create the first case
(title, a few lines of facts, optional files). First result: the issues the AI sees, the sections that apply as
amended today, what facts are missing.

**Case** (the core object): a chat scoped to the case, with every answer citing sections that open in a document
viewer; files (the AI reads them as case context); pinned authorities with a note each; documents (markdown, the
lawyer or the AI writes them; proper drafting of plaints and submissions comes later).

**Plain chat**: quick questions, same grounding, "make this a case".

## Knowledge (agreed 2026-10-15)

**One graph:** the `links` table (doc/chunk → doc/chunk, with a kind). New sources add kinds, not graphs: judgments
`interprets`/`follows`/`overrules`, regulations `made_under`. No graph database.

**Agents:**
- *Research agent* (cheap model, many tool calls): `search(query, scope, filters)`, `read(doc/chunk)`,
  `links(chunk, direction, kinds)`, `as_of(section, date)` (the graph walk, code, no LLM). Returns an evidence pack,
  not prose: `{evidence: [{chunk_id, why}], gaps}`. It narrows the search; quoting and citing are the main agent's
  (user, 2026-10-18; quote and version dropped). `submit` rejects a chunk the agent never read or asOf'd in the run.
- **Changed 2026-10-18 (user, after eval-chat; PIPELINE.md):** one main agent with the research tools (search with
  each hit's change status, read, links grouped by law, asOf with every amendment's text) and no research
  sub-agents: 20/20 gold cited at $0.014 a question; the sub-agents repeated each other's work on one law and ran out
  of steps (3-5x the cost). Sub-agents may come back for case questions spanning several laws.
- *Main agent* (stronger model, as first planned): case summary and file list always in context; runs research agents (in parallel,
  one per sub-question); loads the chunks it judges relevant into its context by `chunk_id`; answers citing only
  chunk ids it has loaded, so the UI can check every citation.

**User files:** Zilliz, a separate collection from the law chunks, one row per file chunk with `workspace_id`,
`scope` (`case:<id>` for files shared in a case, `user:<id>` for a member's private files) and `case_id`, `doc_type`.
Access is filtered *inside* the vector query (Zilliz filter expression, `scope in [...]`), so top-k is never lost to
filtering afterwards; Postgres resolves which scopes the user can see.

**Search (2026-10-17, eval):** dense (bge-m3) by default; the agent picks `weighted` (small BM25 weight) when it
searches for a section, Article or law number or an exact phrase; the query is always English (the agent
translates a Sinhala/Tamil question first) (PIPELINE.md, "Vector layer").

**File ingestion** (async job per uploaded or changed file, keyed by hash): parse to text → one cheap-model read
returning JSON (doc_type: petition, appeal, affidavit, plaint, judgment, contract…; tags, summary, parties, dates,
court, case numbers, laws cited) → chunk + embed into the workspace namespace → cited laws resolved to our doc keys
as links into the law graph → file card in the UI, dates into the case timeline. No knowledge graph over user files
in v1; an entity graph can be built later from the same per-file JSON.

## Decisions

- **Build order (2026-10-17):** M1 a law question answered with citations (scaffold #14, gateway #22, research tools
  #16, viewer #20, plain chat #21); M2 case workspace + main agent (#18, #17); M3 file ingestion (#19); M4 onboarding
  (#15). Judgments (#7) block release, not building.
- **Code and hosting:** a Turborepo + pnpm monorepo inside `app/` (the ETL stays at the root; user, 2026-10-17). In
  one repo because the app depends on the ETL's schema, link kinds, embed text format and Zilliz schema.
  A plain dependency tree (user, 2026-10-18): `apps/web` → `packages/api` (tRPC, thin) → `packages/services`
  (logic) → `packages/db` (the app's database), `packages/etl_db` (the ETL's Neon only: docs, chunks, links,
  read-only), `packages/search` (the vector DB: law chunks and user files; it owns the bge-m3 query embedding,
  because a query vector must come from the model the index was built with, so changing the vector DB or the
  embedding model changes this package alone) and `packages/ai` (LLMs, tools, agents). Only `ai` has ports:
  everything an agent gets comes in one `ctx` (workspace, user, case, scopes, ports) that services builds and
  passes in. Boundaries in `app/CLAUDE.md`. Vercel: Root Directory `app/apps/web`, Ignored Build Step for commits
  outside `app/`.
- **Access (user, 2026-10-18):** tRPC procedures by role: `signedUser` (Clerk session), `superAdmin` (platform
  staff), `workspaceUser` (member of the active org), `workspaceAdmin` (admin/owner), `caseViewer`, `caseEditor`,
  `caseAuthor`, `chatViewer`, `chatOwner`. Sharing is by role: a case's author is its creator; it is shared with a
  user as `viewer` or `editor` (`case_shares`). A chat is its creator's and is shared as viewer only (`chat_shares`).
  Case roles: viewer reads the case (files, pins, docs); editor also chats in it and adds/removes files, pins, docs
  and edits facts; the author also shares, changes roles and deletes. A chat is personal work: nobody else sees
  it, the case author included, unless it is shared.
- **Chats (user, 2026-10-18):** one route, `/chats/[[...id]]`: `/chats` is a new chat (the server mints its uuid,
  a fresh one per visit), `/chats/<id>` a stored one; from a case, `/cases/<caseId>/chats/<id>` (was `?case=` until 2026-10-27). The first message creates the `chats` row (`case_id` null for plain
  chat); a case chat is a normal chat whose `ctx` also has that case's access. Every query filters by user, so
  another user's chat id reads as missing. The document viewer is a sidebar on the chat page: every citation in
  the chat is listed; clicking one loads that chunk (path, amended by / cited by) with "open full document".
  Citations are inline (user, 2026-10-18): the main agent writes `[[chunkId|label]]` (label as a lawyer writes it:
  "s. 22, Rent Act No. 7 of 1972"); the UI renders the answer with Streamdown and each citation as a button with
  that label; a click fetches the chunk by id (`corpus.chunk`: text, changes split at the date, its law) into the
  sidebar, with "open full document" and the source file (`docs.source_url`, the `documents.source_url` of the
  law's file, carried by `etl.publish` from 2026-10-18; null until the next publish). A citation of an id the agent
  never loaded in the chat is marked unverified. The client sends only the new message; history is read from the
  database, so tool outputs cannot be forged. **Changed 2026-10-27:** a case chat is `/cases/<caseId>/chats/<id>`
  (Case-first UI, below); `/chats` is for quick chats only.
- **Files (user, 2026-10-18):** one `files` table is the base of an asset system: one row per file, with its
  extracted content (text, and the ingestion card: doc_type, summary, parties, dates, laws cited). Other tables
  say what a file is used for by referencing `files.id` (a case's files, a message's attachments). A case's
  documents (markdown the lawyer or the AI writes) are files too, no separate table.
- **File pipelines (user, 2026-10-25):** `files` is the general asset table: every uploaded file's row, which
  everything that uses a file references (`case_files` now; later attachments, logos). The row holds only what the
  file is and how far it is processed, **no content** (unlike the law corpus): the original, its text
  (`extract.json`), its card's summary (`card.json`) and its chunks (`chunks.json`) are in R2 under `files/<id>/`, the
  vectors in Zilliz `files`. Categorization is metadata on the row (`category` = doc_type, `meta` = parties, dates,
  court, case numbers, laws cited, tags; how it is used, search filter, UI grouping or per-category handling, is
  open); the vectors carry no doc_type (categorize runs beside index), a search by type resolves to file ids in
  Postgres. Each step (extract, categorize, index)
  has its own state on the row, null when the file does not need it (a logo needs none), and `<step>_by`
  (name@version) so a new extractor, categorizer, embedder or vector DB re-runs only what an older one did. Each
  step is an interface in its package (storage `BlobStore`, extract `Extractor`, ai `Categorizer`, search
  `FileIndex`/`Embedder`); swapping one changes nothing else. No chunk table: chunk ids are `<fileId>:<n>`, stable
  while the chunker is. v1: only the case author can add and see a case's files until `case_shares` exists; the
  agent's case-file search tool waits for the case chat.
- **Fast, on demand, Vercel Workflows (user, 2026-10-25):** a file is ready in under 2 minutes most of the time. The
  steps run as a Vercel Workflow (same project and code, durable steps retried 2 times; no Trigger.dev, Inngest or
  Cloudflare Workflows: a second platform for the same job). extract, then categorize and index at the same time.
  OCR with a cheap provider (user): **the OCR endpoint gets a signed URL to the whole file, fetches it and returns
  its pages as JSON; that is the whole contract** (`OcrProvider`, `httpOcr`: POST {url, mime, filename} ->
  {pages: [{n, text}]}; on when `OCR_URL` is set). We send no bytes and split no pages. A PDF's pages with a text
  layer keep it; OCR fills the ones without. Provider not picked yet; not compared on Sinhala/Tamil scans.
- **Mistral OCR wired, off (user, 2026-10-26):** `mistralOcr` (POST api.mistral.ai/v1/ocr with the signed URL;
  markdown per page, image placeholders dropped) is the first provider, on only with `OCR_PROVIDER=mistral` +
  `MISTRAL_API_KEY` (no key yet). About $4 per 1,000 pages (Mistral pricing, surveyed 2026-10-26); not on Vercel AI
  Gateway, so its own key. Other options surveyed 2026-10-26, none tested on our scans: Gemini Flash via the gateway
  (per token, est. well under $1 per 1,000 pages), Google Cloud Vision (1,000 free/month, then $1.50 per 1,000),
  Document AI (best on Tamil, CER 0.78%, arXiv 2507.18264; Surya best on Sinhala, WER 2.61%), Azure free tier (first
  2 pages per request only: no use), Workers AI `toMarkdown` (text layer only; images are described, not read).
- **Files bucket `sllaw-files` (user, 2026-10-26):** R2, private, location APAC, created 2026-10-26 apart from the
  ETL's `sllaw`. No public access: r2.dev URL disabled, no custom domain; checked 2026-10-26: an unsigned GET is
  refused (400), r2.dev 401, signed GET and PUT 200. Reached only by signed URLs for one file (15 min). CORS: PUT with
  Content-Type from https://sllaw.vercel.app and http://localhost:3000 (preview deployments' domains are not in it:
  uploads from a preview fail until added).
- **Cloudflare tokens per resource (user, 2026-10-26):** the app holds no full-access token. Account tokens:
  `sllaw-app: R2 sllaw-files (objects read/write)` (Bucket Item Read + Write on `sllaw-files` only; its S3 keys are
  `R2_ACCESS_KEY_ID` = token id, `R2_SECRET_ACCESS_KEY` = sha256 of the value) and `sllaw-app: Workers AI (run models)`
  (Workers AI Read: bge-m3 embedding; `CLOUDFLARE_API_TOKEN`). Checked 2026-10-26: the R2 token gets 403 on the ETL
  bucket `sllaw`, the AI token 403 on R2. Set in apps/web/.env.local and Vercel Production. The full-access token stays
  in the repo root .env for the ETL only.
- **Step timeouts (user, 2026-10-26):** each step has a time limit (extract 240 s, categorize 90 s, index 180 s),
  below Vercel's default 300 s function limit, so a slow step ends itself instead of being cut off and left running
  for 15 minutes. The step's calls are cancelled, not abandoned. A timeout is retried (3 attempts in all), then failed
  with "Try again": worst case about 12 minutes for extract before the user hears it failed.
- **Delete and retry wait for the pipeline (user, 2026-10-26):** a file is deleted only once no run is busy with
  it (every step done, failed or no_text; a run silent for 15 minutes counts as stopped). Before, a delete during the
  index step could leave its vectors searchable under the case's scope. A second "Try again" while a run works
  starts nothing, and a run that lost a step to another run cannot write its end (two runs writing one step's
  result was possible on a double click or two tabs).
- **File service, case service, live status (user, 2026-10-26):** file processing is one generic service
  (`services/src/files`): a caller creates a file with the steps it needs (none for a logo; extract for an
  attachment; extract + categorize + index for a case file) and the scopes it is found under, stored on the row
  (`files.scopes`). It knows nothing of cases. A case file goes through the case service (`services/src/cases.ts`:
  `case.addFile` checks the case, creates the file with every step under `case:<id>`, links `case_files`); a
  private file through `file.startUpload` (`user:<id>`). Every upload ends with `file.finishUpload`, which starts a
  workflow run (`files.run_id`). The UI follows the states live: each phase gets a `StateWriter` and writes every
  state it sets to the run's stream (Workflow `getWritable`); `GET /api/files/<id>/events` sends a snapshot of the
  row, then each state as a server-sent event, then `end`; a reconnect resumes after Last-Event-ID. The client keeps
  uploads in one global zustand store (`apps/web/stores/upload-store.ts`: start, PUT with progress, finish, follow),
  shown in a tray on every page and per file with `useFileStatus`. Vercel has no ready-made client hook for a run
  (checked 2026-10-26, workflow 5.2.1: only `WorkflowChatTransport`, for chats). No sweep and no cron (user, 2026-10-26: a file
  stuck for a day is a user gone): a step whose function was cut off is retried by its own run, which claims it back
  at once (`files.run_id`); a step out of retries is `failed` and the UI offers a retry, which also restarts steps a
  stopped run left open.
- **Case workspace UI (user, 2026-10-26):** a Cases link in the sidebar; `/cases` lists the user's cases as cards
  (title, start of the facts, file count) with a New case button; creating (`/cases/new`), editing
  (`/cases/<id>/edit`) and a file's details (`/cases/<id>/files/<fileId>`) are pages, not dialogs (user); only
  "are you sure?" before a delete is a dialog. `/cases/<id>` is the workspace: facts, then the files grouped by
  category (`services/src/cases.ts`, `GROUP_OF`: the categorizer's 40 doc types in 10 groups, "Processing" first
  and "Not categorized" last), upload by button or drop, each file's state live, retry, download, delete.
  Deleting a case deletes its files (vectors, blobs) and chats, and is refused while a run is busy with any of its
  files. Checked against the dev database by `services check-cases` (2026-10-26: ok). Tested in the browser
  2026-10-26 (agent-browser, a Clerk dev test user `+clerk_test`, code 424242; Clerk's bot check blocks headless
  sign-up, so the user was created in the dashboard): 4 files (3 text PDFs, 1 Sinhala/English .txt) Ready in about
  35 s, each in its group; details, download, edit, delete work. That test found R2 refusing every JSON write from
  the pipeline (411 MissingContentLength: aws4fetch sends the body as a stream, which Next's fetch sends chunked);
  `r2.ts` put now signs and sends the bytes with their length. Open: the 411 was recorded as not retryable (any
  4xx), and after a failed extract the UI offered "Try again" (categorize/index left pending) that reruns nothing;
  the Sinhala/English notes were categorized as a counter affidavit. (Files moved to `/cases/<id>/files` and
  `/edit` became `/settings` on 2026-10-27.)
- **Case-first UI (user, 2026-10-27):** the case is where work happens; chat outside a case stays, second.
  Two sidebars from two layouts under `(app)` (one `SidebarProvider` above both): `(main)/layout.tsx` outside a case
  (Home, Cases, the 5 most recent cases, Quick chats: plain chats, 5 then "Show more"), `cases/[id]/layout.tsx`
  inside one (All cases, a case switcher, Overview, Files, the case's chats, Case settings). Routes: `/` Home (recent
  cases, New case, a quick-question box); `/cases/<id>` overview (facts, a question box that starts a case chat, latest
  chats, files by group; the case dashboard grows here); `/cases/<id>/chats/[[...chatId]]`; `/cases/<id>/files`;
  `/cases/<id>/settings`. Case pages to come (documents, tasks, calendar) go in the case sidebar; **connections are
  global** (per user, in settings), never inside a case: a case page uses them. A case chat is a `chats` row with
  `case_id`: the browser sends `caseId` with a new chat's first message, the server checks the case (`caseOf`) and
  keeps a stored chat's own case; the main agent gets the case's title and facts (6,000 chars) at the end of its
  instructions, so the shared start stays in the provider's cache. "Move to case" (`chat.move`) puts a quick chat into
  a case; a stored case chat opened at `/chats/<id>` redirects into its case. Cases list by last activity (created,
  last file, last own chat). Not built: the agent's case-file search tool (#19), connections. Tested in a browser
  2026-10-27 (test user, dev server): case chat from the overview (the answer reasoned from the facts' dates), quick
  chat from Home, move to case, every route, 390 px. Moving route folders into groups left `next dev` serving the old
  tree (404 on every case route) until it was restarted.
- **Retryable and non-retryable errors (user, 2026-10-26):** one rule decides (`services/src/files/errors.ts`).
  Retried: network errors, timeouts, 408, 425, 429, 5xx, unknown errors. Not retried: a file its parser cannot read
  (`Unreadable`: a corrupt PDF, a .docx that is not a zip), other 4xx. Packages only describe their errors (an HTTP
  `status`, the AI SDK's `isRetryable`). The row keeps `{ message, retryable }` per step, so "Try again" shows only
  where it can help; `no_text` is not retryable until OCR is on (then reprocess extract).
- **LLM: DeepSeek** via Vercel AI Gateway (user, 2026-10-17; gateway changed 2026-10-18). The model per task (main agent, research agent, reading
  files) is one config value each, not code: picked later. Not checked yet: DeepSeek's API terms on training and data
  location (the privacy line below depends on it).
  **Cloudflare AI Gateway, dropped 2026-10-18 (why):** gateway `sllaw` (authentication on, logs on, cache_ttl 300 s, no rate
  limit), `cf-aig-authorization` = the Cloudflare token. **Unified Billing does not cover DeepSeek**: it serves
  OpenAI, Anthropic, Google AI Studio, Vertex, xAI and Groq only (docs); a DeepSeek call with no key goes to
  DeepSeek keyless and gets 401 "Authentication Fails (governor)", on both `/deepseek` and `/compat`. OpenAI via
  Unified Billing answered 402 "Insufficient unified billing credits" (none loaded; 5% fee on credits). So DeepSeek
  needs its key stored in the gateway (BYOK, alias `default`; no provider configs stored yet) or sent per request.
  Workers AI through the gateway works (`/compat`, model `workers-ai/@cf/...`, only `cf-aig-authorization`), but on
  the Workers Free plan DeepSeek V4 Pro/Flash, GLM-5.3 and Kimi K2.6 answer 403 "not available on the Workers Free
  plan"; free models with working tool calls: gpt-oss-120b, nemotron-3-120b, qwen3.8-27b, gemma-4-26b,
  glm-4.7-flash, llama-4-scout.
- **App tables never reference `docs`/`chunks` by foreign key or by chunk id alone:** `etl.publish` truncates
  them and a rebuild renumbers chunks. Pinned authorities and saved citations store `doc_key` + `label` + the quote;
  a chunk id is a cache, looked up again when gone.

- **Chats outlive pages, stop is immediate (user, 2026-10-18):** a zustand store (`apps/web/stores/chat-store.ts`) holds one AI SDK `Chat` per chat id, the drafts, `send` and `stop`; pages show a chat with `useChat({ chat })`, which leaves an external Chat running on unmount, so an answer streams on while the user is elsewhere in the app (spinner in the sidebar, a dot when it finished unseen). A new chat's first message moves the question box from the middle to the bottom and brings the thread in (motion `layout`), and `history.pushState` makes the URL `/chats/<id>` without a navigation, so nothing unmounts; a reload loads `/chats/<id>` from the database. Checked in a browser on a copy of the route with a fake slow stream: URL changed in place, words streamed, the answer kept streaming while another chat was open and was complete on return, unread set while away and cleared on return, with the sidebar's refreshes running. **Stop** (send becomes stop while an answer runs) is the SDK's own: the Chat's `stop()` aborts the request, the route forwards `req.signal` as the agent's `abortSignal`, and `onFinish` stores the answer so far (under `after()`, so the write lands). On Vercel this needs `supportsCancellation` (`apps/web/vercel.json`). The server cannot tell stop from a disconnect, so a closed tab, a reload or a lost connection also stops the answer, keeping what was written. Weighed and dropped (user wanted a stop that acts at once): running every answer to the end on the server (`consumeSseStream` under `after()`) with a stop endpoint that sets a flag the run polls every 1.5 s, the SDK's documented pattern for resumable streams ("Stop an Active Resumable Stream"). Measured with the SDK's mock model, abort after 0.7 s: `onFinish` gets the partial text with or without `consumeSseStream` (its `isAborted` is false without it, so the stored message carries no stopped mark).
- **UI (2026-10-18):** shadcn/ui (radix, `apps/web/components/ui`) on Tailwind v4; light/dark/system via next-themes (class on `<html>`). Palette: warm paper + navy ink in light, navy + brass in dark (tokens in `app/globals.css`); Geist for the interface, Source Serif 4 for headings and statute text, so the law reads apart from the answer. Clerk's own `<SignIn/>`/`<SignUp/>` at `/sign-in`, `/sign-up`, styled by mapping `appearance.variables` to the theme's CSS variables; every other page needs a session (`proxy.ts`). Signed in: (sidebar and `/`: Case-first UI, 2026-10-27), citations beside the thread at xl, in a sheet below.
- **Accounts (user, 2026-10-18):** `users`, `workspaces`, `workspace_users` (role: admin | member, Clerk's org role
  without `org:`) keyed by our own uuid, each with its `clerk_id`; everything else in the app refers to our ids. A
  Clerk webhook (`/api/webhooks/clerk`, Svix-verified) keeps them in step: user, organization and
  organizationMembership events, upserts by `clerk_id`; a membership event carries its organization and user, so it
  upserts both and event order does not matter. `signedUser` turns the Clerk session into our account (user, their
  workspaces, the active one = Clerk's active org); `user.me` returns it. A user deleted in Clerk leaves their cases
  with `created_by` null. The app database is `app` in Neon sllaw-app (created 2026-10-18), beside the corpus
  (`neondb`); both share the branch's 512 MB (corpus 179 MB that day). Check: `pnpm --filter @sllaw/services check-accounts`.
- **Auth: Clerk, multi-user workspaces from the start** (Clerk Organizations). Sign-up creates the user's
  workspace; all data is keyed by `workspace_id`, with members and roles in the model. v1 only hides inviting
  members, so opening it later is a UI change.
- **Data:** app reads a new Neon project pushed from ada (#12); vectors in a hosted vector DB (#4); uploaded files
  in R2.
- **Privacy, v1:** no PII masking (it breaks legal reasoning: party names matter, and lawyers already paste files
  into free ChatGPT). LLM via API (not used for training). Deleting a case deletes its files and chunks.
- **Agents: Vercel AI SDK** for chat and the answering tool loop (search chunks, read doc, follow links, read case
  file). Cloudflare Agents SDK later, only for asynchronous work (long jobs, scheduled watches); state stays in Neon.
- **LLM calls go through Vercel AI Gateway** (user, 2026-10-18; the AI SDK's built-in `gateway` provider, no
  provider package): one key for every provider (`AI_GATEWAY_API_KEY` locally, OIDC on Vercel), each call carries
  `providerOptions.gateway.user` = workspace id and `tags` = task (`ai/models.ts`), so spend reports group by
  workspace; fallbacks (`models`), `zeroDataRetention` / `disallowPromptTraining` filters. Cost per workspace is
  what pricing is set from. Embeddings stay on Workers AI (bge-m3, `packages/search`).
- **Usage per message (user, 2026-10-20):** each assistant message stores `usage` (jsonb: model, providers, steps,
  input/cached/output tokens, `cost` = inference, `gatewayCost` = billed, ms, the gateway's generation ids), summed
  over its steps in `streamChat`'s `onStepEnd`. Checked against the gateway's per-generation records. Each `tags`
  entry is billed $0.00015 per call (20% of a 6-step turn, $0.0045). `messages.parts` is **json, not jsonb**:
  jsonb reorders keys, so replayed tool-call inputs differed from what the model sent and the provider's prompt
  cache missed from the first tool call on (turn 2 of a chat: 2,432 of 18,186 input tokens cached). Weighed and
  dropped: keep jsonb and sort keys in a model middleware; `parts` is never queried, and any path around the
  middleware would silently break the cache.
- **Drafting:** later. v1 documents are markdown.
- **Users:** reach lawyers once a working base exists.

## Not decided

- Pricing (per-lawyer monthly in LKR, free tier, student plan: not set).
- Reading uploaded scans: text-layer PDFs and .docx first; scans need an OCR API (LightOn runs on ada, not in
  production).
