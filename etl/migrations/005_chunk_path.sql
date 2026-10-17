-- A chunk's breadcrumb (etl/docs.py chunks(), 2026-10-16): "Part II — Powers of the Council › section 13 — Powers
-- of the Council (cont.)". Only what is certain; NULL when nothing is. Shown by the app and sent with the chunk to
-- the embedding model (etl/embed.py).
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS path TEXT;
