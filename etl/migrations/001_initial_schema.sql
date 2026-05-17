-- 001_initial_schema.sql
-- Core tables for the Sri Lanka Legal Acts spider.

CREATE TABLE IF NOT EXISTS acts (
    id              SERIAL PRIMARY KEY,
    year            INTEGER NOT NULL,
    act_number      TEXT    NOT NULL,        -- e.g. "54/2006"
    certified_date  TEXT,                    -- e.g. "2006-12-28"
    description     TEXT,                    -- scraped title from index page
    pdf_url         TEXT    NOT NULL,        -- full URL to English PDF
    pdf_path        TEXT,                    -- local file path once downloaded

    -- populated after extraction
    title           TEXT,                    -- from cover metadata
    certified       TEXT,
    total_pages     INTEGER,
    parts_count     INTEGER,
    sections_count  INTEGER,
    raw_json        JSONB,                   -- full extract_act output

    -- pipeline state: discovered → downloaded → extracted | failed
    status          TEXT NOT NULL DEFAULT 'discovered',
    error           TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (year, act_number)
);

CREATE TABLE IF NOT EXISTS parts (
    id               SERIAL PRIMARY KEY,
    act_id           INTEGER NOT NULL REFERENCES acts(id) ON DELETE CASCADE,
    part_number      TEXT    NOT NULL,       -- e.g. "I", "II", "A"
    title            TEXT,
    section_numbers  INTEGER[] NOT NULL DEFAULT '{}',
    part_type        TEXT NOT NULL DEFAULT 'part',   -- 'part' or 'chapter'
    UNIQUE (act_id, part_number)
);

CREATE TABLE IF NOT EXISTS sections (
    id              SERIAL PRIMARY KEY,
    act_id          INTEGER NOT NULL REFERENCES acts(id) ON DELETE CASCADE,
    section_number  INTEGER NOT NULL,
    short_title     TEXT,                    -- marginal note
    part_number     TEXT,
    body            JSONB   NOT NULL DEFAULT '[]',
    UNIQUE (act_id, section_number)
);

-- Full-text search index on section body (for --search queries against the DB)
CREATE INDEX IF NOT EXISTS sections_body_gin  ON sections USING GIN (body);
CREATE INDEX IF NOT EXISTS acts_status_idx    ON acts (status);
CREATE INDEX IF NOT EXISTS acts_year_idx      ON acts (year);
