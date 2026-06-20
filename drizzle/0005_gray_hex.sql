ALTER TABLE "drive_session" ADD COLUMN "route_geometry" jsonb;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "route_match_status" text;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "route_matched_at" timestamp with time zone;