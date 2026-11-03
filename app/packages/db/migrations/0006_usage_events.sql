CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid,
	"user_id" uuid,
	"kind" text NOT NULL,
	"task" text NOT NULL,
	"model" text,
	"quantity" jsonb NOT NULL,
	"cost_usd" numeric(18, 10),
	"estimated" boolean DEFAULT false NOT NULL,
	"ref" text,
	"idem" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE INDEX "usage_events_workspace_id_at_index" ON "usage_events" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idem_index" ON "usage_events" USING btree ("idem");--> statement-breakpoint
-- Backfill: every assistant message with usage (stored per message since 2026-10-20) becomes one llm event for its
-- chat's workspace and user. One event per turn, not per step: the steps were summed into the message
-- (steps and the gateway's generation ids are kept). idem message:<id> makes a rerun skip what is there.
INSERT INTO "usage_events" ("at", "workspace_id", "user_id", "kind", "task", "model", "quantity", "cost_usd", "estimated", "ref", "idem", "meta")
SELECT
	m."created_at",
	c."workspace_id",
	c."user_id",
	'llm',
	'chat',
	nullif(m."usage"->>'model', ''),
	jsonb_build_object(
		'input', coalesce((m."usage"->>'input')::bigint, 0),
		'cached', coalesce((m."usage"->>'cached')::bigint, 0),
		'output', coalesce((m."usage"->>'output')::bigint, 0),
		'reasoning', coalesce((m."usage"->>'reasoning')::bigint, 0),
		'steps', coalesce((m."usage"->>'steps')::bigint, 0)
	),
	coalesce((m."usage"->>'gatewayCost')::numeric, (m."usage"->>'cost')::numeric),
	false,
	'chat:' || c."id",
	'message:' || m."id",
	jsonb_build_object(
		'backfill', true,
		'inferenceCost', (m."usage"->>'cost')::numeric,
		'providers', m."usage"->'providers',
		'generations', m."usage"->'generations',
		'ms', (m."usage"->>'ms')::bigint
	)
FROM "messages" m
JOIN "chats" c ON c."id" = m."chat_id"
WHERE m."role" = 'assistant' AND m."usage" IS NOT NULL
ON CONFLICT ("idem") DO NOTHING;
