CREATE TABLE "test_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_run_id" uuid NOT NULL,
	"test_name" text NOT NULL,
	"artifact_type" text NOT NULL,
	"storage_url" text NOT NULL,
	"storage_path" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer,
	"content_type" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "test_artifacts" ADD CONSTRAINT "test_artifacts_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_artifacts_test_run_id_idx" ON "test_artifacts" USING btree ("test_run_id");--> statement-breakpoint
CREATE INDEX "test_artifacts_artifact_type_idx" ON "test_artifacts" USING btree ("artifact_type");