-- 005_consolidated_twopass.sql
-- Two-pass pipeline for consolidated PDF statutes:
--   docling_json  raw per-page cluster data (Pass 1, needs PDF + docling)
--   doc_json      structured document built from docling_json (Pass 2, pure JSON)
-- New status values: docling_done, flagged (mirrors acts pipeline)

ALTER TABLE consolidated_statutes
    ADD COLUMN IF NOT EXISTS docling_json JSONB,
    ADD COLUMN IF NOT EXISTS doc_json     JSONB;
