ALTER TABLE "annotations" ADD COLUMN "client_id" text;--> statement-breakpoint
UPDATE "annotations" SET "client_id" = "id"::text WHERE "client_id" IS NULL;--> statement-breakpoint
ALTER TABLE "annotations" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "annotations_set_client_uniq" ON "annotations" USING btree ("set_id","client_id");
