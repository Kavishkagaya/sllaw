-- 003_act_flags.sql
-- Extraction-quality flags on the acts table.
-- flagged = true whenever any flag_reason was recorded during extraction.
-- flag_reasons = array of short strings like "section_collision:1,2"

ALTER TABLE acts
    ADD COLUMN IF NOT EXISTS flagged      BOOLEAN  NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS flag_reasons TEXT[]   NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS acts_flagged_idx ON acts (flagged) WHERE flagged = true;
