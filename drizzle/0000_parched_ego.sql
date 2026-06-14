CREATE TABLE "charge_session" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "charge_session_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vin" text NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text DEFAULT 'home' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"location_name" text,
	"lat" double precision,
	"lng" double precision,
	"energy_added_kwh" double precision,
	"miles_added_rated" double precision,
	"cost_amount" numeric(12, 4),
	"cost_currency" text,
	"cost_source" text DEFAULT 'computed' NOT NULL,
	"rate_applied" numeric(12, 6),
	"tesla_charge_session_id" text,
	"invoices" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "charge_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drive_session" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drive_session_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vin" text NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"start_odometer" double precision,
	"end_odometer" double precision,
	"distance_mi" double precision,
	"duration_s" integer,
	"start_lat" double precision,
	"start_lng" double precision,
	"end_lat" double precision,
	"end_lng" double precision,
	"start_battery_level" integer,
	"end_battery_level" integer,
	"energy_used_kwh" double precision,
	"wh_per_mi" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "electricity_rate" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'flat' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"flat_rate" numeric(12, 6),
	"tou_schedule" jsonb,
	"loss_factor" numeric(6, 3) DEFAULT 1.1 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "electricity_rate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tesla_account" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"user_email" text,
	"fleet_api_base_url" text,
	"region" text,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tesla_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tesla_charging_history_import" (
	"vin" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"last_page" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tesla_charging_history_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tesla_token" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tesla_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vehicle" (
	"vin" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"tesla_id" text NOT NULL,
	"vehicle_id" text,
	"display_name" text,
	"car_type" text,
	"last_state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vehicle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vehicle_snapshot" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vehicle_snapshot_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vin" text NOT NULL,
	"user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"odometer" double precision,
	"battery_level" integer,
	"usable_battery_level" integer,
	"battery_range" double precision,
	"est_battery_range" double precision,
	"charge_energy_added" double precision,
	"charging_state" text,
	"charger_power" double precision,
	"shift_state" text,
	"latitude" double precision,
	"longitude" double precision,
	"speed" double precision,
	"gps_as_of" timestamp with time zone,
	"raw_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "charge_session" ADD CONSTRAINT "charge_session_vin_vehicle_vin_fk" FOREIGN KEY ("vin") REFERENCES "public"."vehicle"("vin") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_session" ADD CONSTRAINT "charge_session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_session" ADD CONSTRAINT "drive_session_vin_vehicle_vin_fk" FOREIGN KEY ("vin") REFERENCES "public"."vehicle"("vin") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_session" ADD CONSTRAINT "drive_session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electricity_rate" ADD CONSTRAINT "electricity_rate_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tesla_account" ADD CONSTRAINT "tesla_account_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tesla_charging_history_import" ADD CONSTRAINT "tesla_charging_history_import_vin_vehicle_vin_fk" FOREIGN KEY ("vin") REFERENCES "public"."vehicle"("vin") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tesla_charging_history_import" ADD CONSTRAINT "tesla_charging_history_import_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tesla_token" ADD CONSTRAINT "tesla_token_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD CONSTRAINT "vehicle_snapshot_vin_vehicle_vin_fk" FOREIGN KEY ("vin") REFERENCES "public"."vehicle"("vin") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD CONSTRAINT "vehicle_snapshot_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "charge_session_vin_time_idx" ON "charge_session" USING btree ("vin","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "charge_session_tesla_id_uidx" ON "charge_session" USING btree ("tesla_charge_session_id") WHERE "charge_session"."tesla_charge_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "charge_session_open_uidx" ON "charge_session" USING btree ("vin") WHERE "charge_session"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "drive_session_vin_time_idx" ON "drive_session" USING btree ("vin","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "drive_session_open_uidx" ON "drive_session" USING btree ("vin") WHERE "drive_session"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "vehicle_user_idx" ON "vehicle" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vehicle_snapshot_vin_time_idx" ON "vehicle_snapshot" USING btree ("vin","recorded_at" DESC NULLS LAST);