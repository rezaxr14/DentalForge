ALTER TABLE "eval_cases" ADD COLUMN "source_image_id" integer;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "spatial" real;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "diag_sim" real;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "run_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_cases_run_source_uniq" ON "eval_cases" USING btree ("run_id","source_image_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eval_runs_org_run_key_uniq" ON "eval_runs" USING btree ("org_id","run_key");