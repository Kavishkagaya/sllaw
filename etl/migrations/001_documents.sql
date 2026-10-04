-- One row per source file (an Act in three languages = three rows).
-- The file itself lives in R2 at r2_key = source/<sha256>.pdf, written once.
-- Fetch queue: r2_key IS NULL. Extract queue: r2_key IS NOT NULL AND raw_key IS NULL.

CREATE TABLE IF NOT EXISTS documents (
    id          SERIAL PRIMARY KEY,
    source      TEXT        NOT NULL,             -- 'acts', ...
    source_url  TEXT        NOT NULL,
    title       TEXT,
    doc_date    TEXT,
    meta        JSONB       NOT NULL DEFAULT '{}',-- listing record, verbatim
    sha256      TEXT,
    r2_key      TEXT,
    bytes       BIGINT,
    fetched_at  TIMESTAMPTZ,
    raw_key     TEXT,                             -- raw/<version>/<sha256>.json.gz, engine output verbatim
    extracted_at TIMESTAMPTZ,
    error       TEXT,                             -- last failure, cleared on success
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, source_url)
);

CREATE INDEX IF NOT EXISTS documents_sha256_idx    ON documents (sha256);
CREATE INDEX IF NOT EXISTS documents_unfetched_idx ON documents (id) WHERE r2_key IS NULL;
CREATE INDEX IF NOT EXISTS documents_unextracted_idx ON documents (sha256) WHERE r2_key IS NOT NULL AND raw_key IS NULL;
