ALTER TABLE "plan_limits" ALTER COLUMN "max" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "user_limits" ALTER COLUMN "max" SET DATA TYPE double precision;--> statement-breakpoint
-- Limits by spend, not tokens (docs/features/spend-limits.json): USD a Sri Lanka day and month replace context a day
-- and a month. Users' own token limits go too: they no longer mean anything.
DELETE FROM "plan_limits" WHERE "metric" IN ('tokens', 'tokens_month');--> statement-breakpoint
DELETE FROM "user_limits" WHERE "metric" IN ('tokens', 'tokens_month');--> statement-breakpoint
INSERT INTO "plan_limits" ("plan_id", "metric", "max")
SELECT p.id, l.metric, l.max FROM "plans" p, (VALUES ('spend', 0.2), ('spend_month', 2)) AS l(metric, max)
WHERE p.key = 'free'
ON CONFLICT ("plan_id", "metric") DO UPDATE SET "max" = EXCLUDED."max";
