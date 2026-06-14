CREATE TABLE "anomaly_flag" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "anomaly_flag_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vin" text NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"related_charge_id" bigint,
	"related_drive_id" bigint,
	"observed" numeric(12, 4),
	"baseline" numeric(12, 4),
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "anomaly_flag" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "charge_location_type" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "electricity_rate" ADD COLUMN "home_lat" double precision;--> statement-breakpoint
ALTER TABLE "electricity_rate" ADD COLUMN "home_lng" double precision;--> statement-breakpoint
ALTER TABLE "electricity_rate" ADD COLUMN "home_radius_m" numeric(8, 1) DEFAULT 150;--> statement-breakpoint
ALTER TABLE "electricity_rate" ADD COLUMN "departure_target_soc" integer;--> statement-breakpoint
ALTER TABLE "anomaly_flag" ADD CONSTRAINT "anomaly_flag_vin_vehicle_vin_fk" FOREIGN KEY ("vin") REFERENCES "public"."vehicle"("vin") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomaly_flag" ADD CONSTRAINT "anomaly_flag_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomaly_flag" ADD CONSTRAINT "anomaly_flag_related_charge_id_charge_session_id_fk" FOREIGN KEY ("related_charge_id") REFERENCES "public"."charge_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anomaly_flag" ADD CONSTRAINT "anomaly_flag_related_drive_id_drive_session_id_fk" FOREIGN KEY ("related_drive_id") REFERENCES "public"."drive_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anomaly_flag_user_time_idx" ON "anomaly_flag" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "anomaly_flag_charge_uidx" ON "anomaly_flag" USING btree ("type","related_charge_id") WHERE "anomaly_flag"."related_charge_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "anomaly_flag_drive_uidx" ON "anomaly_flag" USING btree ("type","related_drive_id") WHERE "anomaly_flag"."related_drive_id" is not null;