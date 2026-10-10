-- Documents, their text in chunks, and links between documents (decision 2026-10-10, user): no section/schedule
-- assembly. Each document's text is read in reading order (LightOnOCR-3 for PDFs, marginal notes inline; HTML
-- converted to the same form), cut into chunks, and a link says "this document (this chunk) amends / cites that
-- document (that chunk)". The replacing text is not copied into a link: it is in the source chunk.
-- acts / sections / edges (002) are kept, unused by this model.

-- One row per legal document: Act, Law, Ordinance, Revised Edition chapter, Constitution amendment; later judgments.
CREATE TABLE IF NOT EXISTS docs (
    key          TEXT PRIMARY KEY,               -- act:9/2023 | law:5/1972 | ordinance:13/1946 | cap:107 | cap1956:262 | amendment:21
    kind         TEXT NOT NULL,                  -- act | law | ordinance | chapter1980 | chapter1956 | amendment | judgment
    title        TEXT,
    year         INT,
    certified    DATE,
    commenced    DATE,                           -- in force from; what a walk filters on
    commencement JSONB,                          -- {kind: date|deemed|certified|appointed|unstated, text}
    document_id  INT REFERENCES documents(id),   -- the source file its text came from
    text_from    TEXT,                           -- lighton | html
    built_with   TEXT,                           -- code version (etl/docs.py BUILD)
    meta         JSONB NOT NULL DEFAULT '{}',
    built_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The document's text, in order. label: what the chunk opens, when it opens one ('section 22', 'First Schedule',
-- 'Article 91'); the target a link's label resolves to.
CREATE TABLE IF NOT EXISTS chunks (
    id       BIGSERIAL PRIMARY KEY,
    doc_key  TEXT NOT NULL REFERENCES docs(key) ON DELETE CASCADE,
    seq      INT  NOT NULL,
    label    TEXT,
    text     TEXT NOT NULL,
    UNIQUE (doc_key, seq)
);
CREATE INDEX IF NOT EXISTS chunks_label_idx ON chunks (doc_key, label);

-- Document -> document. dst_label NULL = the whole document. context: the note or citing sentence, short.
CREATE TABLE IF NOT EXISTS links (
    id         BIGSERIAL PRIMARY KEY,
    src_doc    TEXT NOT NULL REFERENCES docs(key) ON DELETE CASCADE,
    src_chunk  BIGINT REFERENCES chunks(id) ON DELETE SET NULL,
    kind       TEXT NOT NULL,                    -- amends | inserts | replaces | repeals | amends_act | repeals_act | cites | same_as
    dst_doc    TEXT NOT NULL,                    -- may be a document not held
    dst_label  TEXT,
    dst_chunk  BIGINT REFERENCES chunks(id) ON DELETE SET NULL,
    date       DATE,                             -- the source's commencement
    context    TEXT
);
CREATE INDEX IF NOT EXISTS links_dst_idx ON links (dst_doc, dst_label);
CREATE INDEX IF NOT EXISTS links_src_idx ON links (src_doc);
