CREATE TABLE "plan_limits" (
	"plan_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"max" bigint NOT NULL,
	CONSTRAINT "plan_limits_plan_id_metric_pk" PRIMARY KEY("plan_id","metric")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "user_limits" (
	"user_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"max" bigint,
	"expires_at" timestamp with time zone,
	"note" text,
	"set_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_limits_user_id_metric_pk" PRIMARY KEY("user_id","metric")
);
--> statement-breakpoint
CREATE TABLE "user_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"source" text DEFAULT 'staff' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"note" text,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_limits" ADD CONSTRAINT "plan_limits_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_limits" ADD CONSTRAINT "user_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_limits" ADD CONSTRAINT "user_limits_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plans" ADD CONSTRAINT "user_plans_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_default" ON "plans" USING btree ("is_default") WHERE "plans"."is_default";--> statement-breakpoint
CREATE INDEX "user_plans_user_id_index" ON "user_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_events_user_id_at_index" ON "usage_events" USING btree ("user_id","at");--> statement-breakpoint
-- The default plan (docs/APP.md, Limits); edited on /admin/plans from here on.
INSERT INTO "plans" ("key", "name", "is_default") VALUES ('free', 'Free', true);--> statement-breakpoint
INSERT INTO "plan_limits" ("plan_id", "metric", "max")
SELECT p.id, l.metric, l.max FROM "plans" p, (VALUES
  ('messages', 10),
  ('tokens', 300000),
  ('tokens_month', 4000000),
  ('searches', 300),
  ('case_files', 20),
  ('storage', 1073741824)
) AS l(metric, max) WHERE p.key = 'free';
