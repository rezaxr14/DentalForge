DROP INDEX "traces_content_uniq";--> statement-breakpoint
CREATE INDEX "traces_content_idx" ON "traces" USING btree ("content_hash");