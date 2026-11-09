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

-- Stage 6 (docs/LINKS.md): mentions = every citation as read, one row per span of text (etl/mentions.py), resolved or
-- not; links = resolved edges only, one source chunk -> one destination (a chunk, or the law for a whole-law
-- citation), built from mentions by `resolve`. A repealed Part gives one link per section under it (`part`).
CREATE TABLE IF NOT EXISTS mentions (
    id            BIGSERIAL PRIMARY KEY,
    src_doc       TEXT NOT NULL REFERENCES docs(key) ON DELETE CASCADE,
    src_chunk     UUID REFERENCES chunks(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                 -- relation, plus _act for a whole law (amends_act, repeals_act)
    dst_doc       TEXT,                          -- the law cited (null: not identified, see dst_name)
    dst_name      TEXT,
    dst_label     TEXT,                          -- the provision when there is exactly one (else see labels)
    context       TEXT,
    detail        JSONB
);
ALTER TABLE mentions
    ADD COLUMN IF NOT EXISTS start_at     INT,            -- character offsets in the chunk text (R2)
    ADD COLUMN IF NOT EXISTS end_at       INT,
    ADD COLUMN IF NOT EXISTS span         TEXT,           -- the text at those offsets
    ADD COLUMN IF NOT EXISTS relation     TEXT,           -- amends|inserts|replaces|repeals|rescinds|made_under|consolidates|cites
    ADD COLUMN IF NOT EXISTS scope        TEXT,           -- provision|part|schedule|title|whole_law
    ADD COLUMN IF NOT EXISTS law_form     TEXT,           -- number|chapter|name|principal|defined|anaphora|this_law|constitution|amendment|gazette|statute
    ADD COLUMN IF NOT EXISTS law_text     TEXT,
    ADD COLUMN IF NOT EXISTS dst_type     TEXT,           -- law|constitution|amendment|gazette|statute|self
    ADD COLUMN IF NOT EXISTS unit         TEXT,           -- section|article|schedule|part|chapter|title
    ADD COLUMN IF NOT EXISTS labels       TEXT[],         -- every provision named, ranges expanded
    ADD COLUMN IF NOT EXISTS sub          TEXT,           -- "(2)(a)"
    ADD COLUMN IF NOT EXISTS in_quote     BOOLEAN,        -- inside quoted text an amendment inserts
    ADD COLUMN IF NOT EXISTS confidence   TEXT,           -- high|medium|low, by rule
    ADD COLUMN IF NOT EXISTS via          TEXT,           -- the pattern that read it
    ADD COLUMN IF NOT EXISTS ops          JSONB,          -- the edits of a change
    ADD COLUMN IF NOT EXISTS status       TEXT,           -- resolve: resolved|partial|inserted|label_not_found|not_held|unidentified
    ADD COLUMN IF NOT EXISTS unresolved   TEXT[],         -- resolve: the labels that gave no link
    ADD COLUMN IF NOT EXISTS refs_version TEXT;
CREATE INDEX IF NOT EXISTS mentions_dst_idx ON mentions (dst_doc, dst_label);
CREATE INDEX IF NOT EXISTS mentions_src_idx ON mentions (src_doc);
-- the links table before 2026-11-09 was one row per mention with a status (unresolved ones too): replaced
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = 'links' AND column_name = 'status') THEN
        DROP TABLE links;
    END IF;
END $$;
DROP TABLE IF EXISTS part_links;
CREATE TABLE IF NOT EXISTS links (
    id            BIGSERIAL PRIMARY KEY,
    mention_id    BIGINT NOT NULL REFERENCES mentions(id) ON DELETE CASCADE,
    src_doc       TEXT NOT NULL,
    src_chunk     UUID,                          -- null: the long title
    kind          TEXT NOT NULL,
    dst_doc       TEXT NOT NULL,                 -- the document reached (the law cited, or its same_as twin)
    dst_label     TEXT,                          -- null: the whole law
    dst_chunk     UUID,                          -- null only for a whole law
    part          TEXT,                          -- from a repealed Part / Chapter: the Part named
    via_alias     BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS links_src_idx ON links (src_doc);
CREATE INDEX IF NOT EXISTS links_mention_idx ON links (mention_id);
CREATE INDEX IF NOT EXISTS links_dst_idx ON links (dst_doc, dst_label);

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
