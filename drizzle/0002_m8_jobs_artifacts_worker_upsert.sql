ALTER TABLE "jobs" ADD COLUMN "artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workers_org_name_uniq" ON "workers" USING btree ("org_id","name");