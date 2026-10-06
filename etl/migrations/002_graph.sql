-- Structured English Acts and the amendment graph, built by etl/graph.py from raw extraction.
-- Rebuildable: graph.py deletes and rewrites an Act's rows each time it structures that Act.
-- Keys: 'act:9/2023' for an Act, 'cap:107' for a pre-1980 Ordinance (Legislative Enactments
-- chapter), known only as a target until its text is in the corpus.

CREATE TABLE IF NOT EXISTS acts (
    key          TEXT PRIMARY KEY,               -- act:9/2023
    document_id  INT REFERENCES documents(id),   -- the English source file
    raw_key      TEXT,                           -- the raw it was built from: incremental builds skip
    built_with   TEXT,                           -- an Act whose raw_key and built_with are unchanged
    title        TEXT,
    long_title   TEXT,
    certified    DATE,                           -- documents.doc_date
    commenced    DATE,                           -- in force from (explicit or deemed date); else = certified
    commencement JSONB,                          -- {kind: date|deemed|certified|appointed|unstated, text}
    warnings     JSONB NOT NULL DEFAULT '[]',
    doc          JSONB NOT NULL,                 -- etl.structure.act() output, whole
    structured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every retrievable part of an Act. kind: section | schedule | preamble. num is what edges point at:
-- '12A' for a section, 'First Schedule' / 'Schedule A' / 'Schedule' for a schedule, 'Preamble'.
CREATE TABLE IF NOT EXISTS sections (
    act_key  TEXT NOT NULL REFERENCES acts(key) ON DELETE CASCADE,
    num      TEXT NOT NULL,
    kind     TEXT NOT NULL DEFAULT 'section',
    seq      INT  NOT NULL,                      -- order within the Act
    note     TEXT,                               -- marginal note; for a schedule its "[Section 41]" reference
    part     TEXT,
    chapter  TEXT,
    heading  TEXT,                               -- cross-heading over a group of sections
    text     TEXT NOT NULL,                      -- paragraphs joined, labels kept; table rows as "a | b | c"
    PRIMARY KEY (act_key, num)
);

-- src section does `kind` to dst. dst_section NULL = the whole Act (long-title amendment, repeal, citation).
CREATE TABLE IF NOT EXISTS edges (
    id           SERIAL PRIMARY KEY,
    src_act      TEXT NOT NULL REFERENCES acts(key) ON DELETE CASCADE,
    src_section  TEXT,
    kind         TEXT NOT NULL,                  -- amends | replaces | repeals | inserts | amends_act | repeals_act | cites | same_as
    dst_act      TEXT NOT NULL,                  -- may name an Act not (yet) in acts
    dst_section  TEXT,                           -- a sections.num: '22', '12A', 'First Schedule'
    date         DATE,                           -- src act's commenced date: what the walk filters on
    new_text     TEXT,                           -- the quoted text the amendment puts in
    evidence     TEXT                            -- the note or sentence the edge was read from
);

CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges (dst_act, dst_section);
CREATE INDEX IF NOT EXISTS edges_src_idx ON edges (src_act);
