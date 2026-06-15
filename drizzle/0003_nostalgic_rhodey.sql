CREATE TABLE "address" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "address_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"osm_id" bigint,
	"osm_type" text,
	"display_name" text,
	"name" text,
	"house_number" text,
	"road" text,
	"neighbourhood" text,
	"city" text,
	"county" text,
	"postcode" text,
	"state" text,
	"state_district" text,
	"country" text,
	"lat" double precision,
	"lng" double precision,
	"raw_json" jsonb,
	"geofence_id" bigint,
	"source_pk" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "address" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "geofence" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "geofence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"radius_m" numeric(8, 1) DEFAULT 150 NOT NULL,
	"billing_type" text DEFAULT 'per_kwh' NOT NULL,
	"cost_per_unit" numeric(12, 6),
	"session_fee" numeric(12, 4),
	"currency" text,
	"is_home" boolean DEFAULT false NOT NULL,
	"source_pk" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geofence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_batch_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"source" text DEFAULT 'teslamate' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"preferred_range" text,
	"cutover_at" timestamp with time zone,
	"file_checksums" jsonb,
	"cursors" jsonb,
	"row_counts" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "import_batch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "import_pk_map" (
	"import_batch_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"old_id" bigint NOT NULL,
	"new_id" bigint,
	"new_vin" text
);
--> statement-breakpoint
ALTER TABLE "import_pk_map" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "software_update" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "software_update_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vin" text NOT NULL,
	"user_id" uuid NOT NULL,
	"version" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"import_source" text DEFAULT 'live' NOT NULL,
	"source_pk" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "software_update" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "vehicle_state" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vehicle_state_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vin" text NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"import_source" text DEFAULT 'live' NOT NULL,
	"source_pk" bigint
);
--> statement-breakpoint
ALTER TABLE "vehicle_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "energy_used_kwh" double precision;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "start_range_mi" double precision;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "end_range_mi" double precision;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "start_battery_level" integer;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "end_battery_level" integer;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "outside_temp_avg" double precision;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "fast_charger_type" text;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "geofence_id" bigint;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "address_id" bigint;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "import_source" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "charge_session" ADD COLUMN "source_pk" bigint;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "start_range_mi" double precision;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "end_range_mi" double precision;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "outside_temp_avg" double precision;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "inside_temp_avg" double precision;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "speed_max_mph" integer;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "power_max_kw" integer;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "power_min_kw" integer;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "ascent" integer;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "descent" integer;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "start_snapshot_id" bigint;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "end_snapshot_id" bigint;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "start_address_id" bigint;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "end_address_id" bigint;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "start_geofence_id" bigint;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "end_geofence_id" bigint;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "import_source" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_session" ADD COLUMN "source_pk" bigint;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "trim_badging" text;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "marketing_name" text;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "exterior_color" text;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "wheel_type" text;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "spoiler_type" text;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "pack_kwh" numeric(8, 3);--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "efficiency_wh_per_mi" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "is_lfp" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "free_supercharging" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "display_priority" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "charger_voltage" integer;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "charger_actual_current" integer;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "charger_phases" integer;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "power_kw" double precision;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "elevation_m" integer;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "source_drive_id" bigint;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "source_charge_id" bigint;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "import_source" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "vehicle_snapshot" ADD COLUMN "source_pk" bigint;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofence" ADD CONSTRAINT "geofence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_pk_map" ADD CONSTRAINT "import_pk_map_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_update" ADD CONSTRAINT "software_update_vin_vehicle_vin_fk" FOREIGN KEY ("vin") REFERENCES "public"."vehicle"("vin") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_update" ADD CONSTRAINT "software_update_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_state" ADD CONSTRAINT "vehicle_state_vin_vehicle_vin_fk" FOREIGN KEY ("vin") REFERENCES "public"."vehicle"("vin") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_state" ADD CONSTRAINT "vehicle_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "address_user_idx" ON "address" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "address_osm_uidx" ON "address" USING btree ("user_id","osm_id","osm_type") WHERE "address"."osm_id" is not null;--> statement-breakpoint
CREATE INDEX "geofence_user_idx" ON "geofence" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "geofence_name_uidx" ON "geofence" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "import_pk_map_uidx" ON "import_pk_map" USING btree ("import_batch_id","entity","old_id");--> statement-breakpoint
CREATE INDEX "software_update_vin_time_idx" ON "software_update" USING btree ("vin","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "software_update_uidx" ON "software_update" USING btree ("vin","started_at","version");--> statement-breakpoint
CREATE INDEX "vehicle_state_vin_time_idx" ON "vehicle_state" USING btree ("vin","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_state_open_uidx" ON "vehicle_state" USING btree ("vin") WHERE "vehicle_state"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_state_start_uidx" ON "vehicle_state" USING btree ("vin","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "charge_session_import_uidx" ON "charge_session" USING btree ("vin","started_at") WHERE "charge_session"."import_source" <> 'live';--> statement-breakpoint
CREATE UNIQUE INDEX "drive_session_import_uidx" ON "drive_session" USING btree ("vin","started_at") WHERE "drive_session"."import_source" <> 'live';--> statement-breakpoint
CREATE INDEX "vehicle_snapshot_drive_idx" ON "vehicle_snapshot" USING btree ("source_drive_id");--> statement-breakpoint
CREATE INDEX "vehicle_snapshot_charge_idx" ON "vehicle_snapshot" USING btree ("source_charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_snapshot_import_uidx" ON "vehicle_snapshot" USING btree ("vin","import_source","source_pk") WHERE "vehicle_snapshot"."source_pk" is not null;