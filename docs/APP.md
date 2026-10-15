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

## Decisions

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
- Which LLM and model per task (answers vs. reading files).
