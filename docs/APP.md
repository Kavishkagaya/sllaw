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
- **Chats (user, 2026-10-18):** the client mints the chat id (uuid) on "New chat" and opens `/chat/[chatId]`; from
  a case, `/chat/[chatId]?case=<caseId>`. The first message creates the `chats` row (`case_id` null for plain
  chat); a case chat is a normal chat whose `ctx` also has that case's access. Every query filters by user, so
  another user's chat id reads as missing. The document viewer is a sidebar on the chat page: every citation in
  the chat is listed; clicking one loads that chunk (path, amended by / cited by) with "open full document".
- **Files (user, 2026-10-18):** one `files` table is the base of an asset system: one row per file, with its
  extracted content (text, and the ingestion card: doc_type, summary, parties, dates, laws cited). Other tables
  say what a file is used for by referencing `files.id` (a case's files, a message's attachments). A case's
  documents (markdown the lawyer or the AI writes) are files too, no separate table.
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
- **Drafting:** later. v1 documents are markdown.
- **Users:** reach lawyers once a working base exists.

## Not decided

- Pricing (per-lawyer monthly in LKR, free tier, student plan: not set).
- Reading uploaded scans: text-layer PDFs and .docx first; scans need an OCR API (LightOn runs on ada, not in
  production).
