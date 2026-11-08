-- Pipeline v2 state (docs/PIPELINE_V2.md, "State and workers"): small rows only; every byte (files, raw, trees,
-- chunk text) is in R2. One database shared by every worker; work is claimed with FOR UPDATE SKIP LOCKED and a
-- lease that expires. Applied by `python -m etl.v2.run init` (idempotent).

-- Stage 1: what every spider lists, every language, never filtered on another source; never deleted.
CREATE TABLE IF NOT EXISTS listings (
    id            BIGSERIAL PRIMARY KEY,
    source        TEXT NOT NULL,                 -- documents.gov.lk | parliament.lk | lankalaw | commonlii | ...
    spider        TEXT NOT NULL,                 -- acts | constitution | le1980 | ...
    source_url    TEXT NOT NULL,
    type          TEXT NOT NULL,                 -- act | law | revised_1980 | gazette | constitution_amendment | ...
    listed_key    TEXT,                          -- what the listing claims: act:9/2023
    title         TEXT,
    date          TEXT,
    date_precision TEXT,                         -- day | year
    language      TEXT,                          -- ENGLISH | SINHALA | TAMIL
    format        TEXT,                          -- pdf | html
    listing       JSONB NOT NULL DEFAULT '{}',   -- the record verbatim
    first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, source_url)
);
CREATE INDEX IF NOT EXISTS listings_key_idx ON listings (listed_key);

-- Stage 2: files, stored once per sha256 (R2 source/<sha256>.<ext>, manifest source/<sha256>.json)
CREATE TABLE IF NOT EXISTS files (
    sha256        TEXT PRIMARY KEY,
    ext           TEXT NOT NULL,
    bytes         BIGINT,
    content_type  TEXT,
    r2_key        TEXT NOT NULL,
    raw_key       TEXT,                          -- stage 3's output (raw/v2/<sha256>.json.gz)
    lighton       BOOLEAN NOT NULL DEFAULT FALSE,-- raw/lighton/<sha256>.json.gz exists (scanned pages read by LightOn)
    first_fetched TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS listing_files (            -- which listing gave which file (a manifest's rows)
    listing_id    BIGINT PRIMARY KEY REFERENCES listings(id),
    sha256        TEXT REFERENCES files(sha256),
    fetched_from  TEXT,                          -- differs from source_url when the Wayback fallback was used
    fetched_at    TIMESTAMPTZ,
    error         TEXT                           -- the last failed download, if any
);

-- the file chosen per document: rank per type, then language, then human fixes (etl/overrides.json)
CREATE TABLE IF NOT EXISTS documents (
    key           TEXT PRIMARY KEY,              -- act:9/2023
    type          TEXT NOT NULL,
    title         TEXT,
    listing_id    BIGINT REFERENCES listings(id),
    sha256        TEXT REFERENCES files(sha256),
    language      TEXT,
    chosen_by     TEXT,                          -- rank | language fallback | pin
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stages 4-5: a document's tree (R2 tree/<hash>.json) and chunks; the chunk text is in R2 (app/law/<hash>.json)
CREATE TABLE IF NOT EXISTS docs (
    key           TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    title         TEXT,
    year          INT,
    sha256        TEXT,                          -- the file it was built from
    tree_key      TEXT,
    parts         TEXT[],                        -- R2 text parts, in order
    fingerprint   TEXT,                          -- what it was built from (inputs + code version)
    meta          JSONB NOT NULL DEFAULT '{}',   -- long_title (etl.refs reads it for names)
    built_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chunks (
    id            UUID PRIMARY KEY,              -- uuid5(namespace, address)
    doc_key       TEXT NOT NULL REFERENCES docs(key) ON DELETE CASCADE,
    address       TEXT NOT NULL UNIQUE,          -- act:7/2007/Part II/22/2: key and breadcrumb in one
    seq           INT NOT NULL,
    label         TEXT,                          -- what links point at: '22', 'First Schedule'
    kind          TEXT,                          -- unit | schedule | front | block
    crumb         TEXT,
    part          INT,                           -- index into docs.parts
    text_hash     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_doc_idx ON chunks (doc_key, seq);
CREATE INDEX IF NOT EXISTS chunks_label_idx ON chunks (doc_key, label);

-- Stage 6: mentions read once per document (outward); links are mentions resolved inside the database
CREATE TABLE IF NOT EXISTS mentions (
    id            BIGSERIAL PRIMARY KEY,
    src_doc       TEXT NOT NULL REFERENCES docs(key) ON DELETE CASCADE,
    src_chunk     UUID REFERENCES chunks(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                 -- amends | inserts | replaces | repeals | cites | ...
    dst_doc       TEXT,                          -- the target law's key when the text names its number
    dst_name      TEXT,                          -- or its name, resolved in the database
    dst_label     TEXT,
    context       TEXT,
    detail        JSONB
);
CREATE INDEX IF NOT EXISTS mentions_dst_idx ON mentions (dst_doc, dst_label);
CREATE INDEX IF NOT EXISTS mentions_src_idx ON mentions (src_doc);
CREATE TABLE IF NOT EXISTS links (
    mention_id    BIGINT PRIMARY KEY REFERENCES mentions(id) ON DELETE CASCADE,
    dst_doc       TEXT,
    dst_chunk     UUID,
    status        TEXT NOT NULL                  -- resolved | label_not_found | target_not_held
);

-- a repealed Part or Chapter: one row per section under it (resolve fills it; issue #9, as etl.docs did)
CREATE TABLE IF NOT EXISTS part_links (
    mention_id    BIGINT NOT NULL REFERENCES mentions(id) ON DELETE CASCADE,
    dst_doc       TEXT NOT NULL,
    dst_label     TEXT NOT NULL,
    dst_chunk     UUID NOT NULL,
    PRIMARY KEY (mention_id, dst_chunk)
);

-- the builder's own feedback, per document and stage (etl/v2/checks.py)
CREATE TABLE IF NOT EXISTS issues (
    key           TEXT NOT NULL,
    stage         TEXT NOT NULL,
    check_name    TEXT NOT NULL,
    severity      TEXT NOT NULL,                 -- error | warn | accepted | info
    place         TEXT,
    page          INT,
    evidence      TEXT,
    cause         TEXT,
    at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS issues_key_idx ON issues (key, stage);

-- the work queue: one row per (stage, item); an item is skipped when it is done for the same fingerprint
CREATE TABLE IF NOT EXISTS work (
    stage         TEXT NOT NULL,
    item          TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'todo',  -- todo | running | done | failed
    lease_by      TEXT,
    lease_until   TIMESTAMPTZ,
    tries         INT NOT NULL DEFAULT 0,
    error         TEXT,
    output        JSONB,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stage, item)
);
CREATE INDEX IF NOT EXISTS work_todo_idx ON work (stage, status);

-- same_as between editions and old laws (etl.graph.link today): kept as pairs, read by link resolution
CREATE TABLE IF NOT EXISTS same_as (
    a             TEXT NOT NULL,
    b             TEXT NOT NULL,
    PRIMARY KEY (a, b)
);

-- stages 7-8: what was last sent downstream, per document (publish) and per chunk (embed), to send only changes
CREATE TABLE IF NOT EXISTS published (
    key           TEXT PRIMARY KEY,
    fingerprint   TEXT NOT NULL,                 -- docs.fingerprint + its links' hash when it was published
    at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- English scanned pages waiting for OCR (extract sets it when no OCR server was up; the ocr stage clears it)
ALTER TABLE files ADD COLUMN IF NOT EXISTS ocr_pages INT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS ocr_lang TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS ocr_engine TEXT;   -- set when a file's raw was re-read with OCR (docling + Surya)

-- gated = the state hash the quality gate last passed (publish --apply refuses any other); embedded = kb hash last embedded
CREATE TABLE IF NOT EXISTS marks (name TEXT PRIMARY KEY, value TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
