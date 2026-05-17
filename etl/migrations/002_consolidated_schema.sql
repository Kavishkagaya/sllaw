-- 002_consolidated_schema.sql
-- Tables for consolidated statutes (multiple collections: 2006, 2024, ...).

CREATE TABLE IF NOT EXISTS consolidated_statutes (
    id          SERIAL PRIMARY KEY,
    collection  TEXT    NOT NULL,          -- e.g. '2006', '2024'
    source_url  TEXT    NOT NULL,
    source_type TEXT    NOT NULL DEFAULT 'html',  -- 'html' or 'pdf'
    html_code   TEXT,                      -- e.g. "2000Y0V0C46A" (html only)
    index_title TEXT    NOT NULL,
    is_repealed BOOLEAN NOT NULL DEFAULT false,

    -- populated after extraction (html only initially; pdf needs docling)
    title           TEXT,
    description     TEXT,
    enacted_date    TEXT,
    parts_count     INTEGER,
    sections_count  INTEGER,
    raw_json        JSONB,

    -- pipeline: discovered → extracted | failed
    -- pdf source_type stays 'discovered' until a pdf-extract step runs
    status      TEXT NOT NULL DEFAULT 'discovered',
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (collection, source_url)
);

CREATE TABLE IF NOT EXISTS consolidated_parts (
    id              SERIAL PRIMARY KEY,
    statute_id      INTEGER NOT NULL REFERENCES consolidated_statutes(id) ON DELETE CASCADE,
    part_number     TEXT    NOT NULL,
    title           TEXT,
    section_numbers TEXT[]  NOT NULL DEFAULT '{}',
    part_type       TEXT    NOT NULL DEFAULT 'part',
    UNIQUE (statute_id, part_number)
);

CREATE TABLE IF NOT EXISTS consolidated_sections (
    id              SERIAL PRIMARY KEY,
    statute_id      INTEGER NOT NULL REFERENCES consolidated_statutes(id) ON DELETE CASCADE,
    section_number  TEXT    NOT NULL,
    short_title     TEXT,
    part_number     TEXT,
    body            TEXT    NOT NULL DEFAULT '',
    UNIQUE (statute_id, section_number)
);

CREATE INDEX IF NOT EXISTS consolidated_statutes_status_idx
    ON consolidated_statutes (status);
CREATE INDEX IF NOT EXISTS consolidated_statutes_collection_idx
    ON consolidated_statutes (collection);
CREATE INDEX IF NOT EXISTS consolidated_sections_fts
    ON consolidated_sections
    USING GIN (to_tsvector('english', body));
