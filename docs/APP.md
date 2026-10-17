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
  not prose: `[{chunk_id, quote, why, version as of date}]`.
- *Main agent* (stronger model): case summary and file list always in context; runs research agents (in parallel,
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
  `apps/web` Next.js → `packages/api` tRPC (thin) → `packages/ai` models + agents → `packages/services` logic →
  `packages/db` (the app's database) and `packages/etl_db` (the corpus the ETL publishes, a separate database,
  read-only, with Zilliz). Boundaries in `app/CLAUDE.md`. Vercel: Root Directory `app/apps/web`, Ignored Build
  Step for commits outside `app/`.
- **LLM: DeepSeek** via AI Gateway (user, 2026-10-17). The model per task (main agent, research agent, reading
  files) is one config value each, not code: picked later. Not checked yet: DeepSeek's API terms on training and data
  location (the privacy line below depends on it).
- **App tables never reference `docs`/`chunks` by foreign key or by chunk id alone:** `etl.publish` truncates
  them and a rebuild renumbers chunks. Pinned authorities and saved citations store `doc_key` + `label` + the quote;
  a chunk id is a cache, looked up again when gone.

- **Auth: Clerk, multi-user workspaces from the start** (Clerk Organizations). Sign-up creates the user's
  workspace; all data is keyed by `workspace_id`, with members and roles in the model. v1 only hides inviting
  members, so opening it later is a UI change.
- **Data:** app reads a new Neon project pushed from ada (#12); vectors in a hosted vector DB (#4); uploaded files
  in R2.
- **Privacy, v1:** no PII masking (it breaks legal reasoning: party names matter, and lawyers already paste files
  into free ChatGPT). LLM via API (not used for training). Deleting a case deletes its files and chunks.
- **Agents: Vercel AI SDK** for chat and the answering tool loop (search chunks, read doc, follow links, read case
  file). Cloudflare Agents SDK later, only for asynchronous work (long jobs, scheduled watches); state stays in Neon.
- **LLM calls go through Cloudflare AI Gateway** (the AI SDK provider's `baseURL`): logs, cost per request tagged
  with workspace, caching, rate limits, provider fallback. Cost per workspace is what pricing is set from.
- **Drafting:** later. v1 documents are markdown.
- **Users:** reach lawyers once a working base exists.

## Not decided

- Pricing (per-lawyer monthly in LKR, free tier, student plan: not set).
- Reading uploaded scans: text-layer PDFs and .docx first; scans need an OCR API (LightOn runs on ada, not in
  production).
