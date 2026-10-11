-- Links read from the text alone (etl/refs.py, decision 2026-10-10, user: no marginal notes). detail: how the text
-- says it, {via: text|long_title|history|side_by_side, ops: [{op: substitute|replace|repeal|insert|add|omit|renumber,
-- loc, old, new, where, at}], anchor: "after section 16"}. kind gains 'consolidates' (a Revised Edition chapter's
-- list of the laws it consolidates).
ALTER TABLE links ADD COLUMN IF NOT EXISTS detail JSONB;
