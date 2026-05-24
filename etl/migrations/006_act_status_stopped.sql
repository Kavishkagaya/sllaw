-- 006_act_status_stopped.sql
-- Rename the ambiguous status='flagged' (parser stopped mid-parse) to
-- status='stopped' so it no longer collides visually with the flagged boolean.
-- The flagged boolean means "has quality flags in flag_reasons"; stopped means
-- "stage2 gave up parsing before completing".  With the new parser, acts that
-- previously stopped now run to completion and land in status='extracted'.

UPDATE acts SET status = 'stopped' WHERE status = 'flagged';
