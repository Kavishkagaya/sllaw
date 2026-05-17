-- 004_two_pass.sql
-- Split extraction into two columns:
--   docling_json  raw per-page cluster data (Pass 1, needs PDF + GPU)
--   doc_json      structured document built from docling_json (Pass 2, pure JSON)
-- New status: discovered → downloaded → docling_done → extracted

ALTER TABLE acts
    ADD COLUMN IF NOT EXISTS docling_json JSONB,
    ADD COLUMN IF NOT EXISTS doc_json     JSONB;
