/**
 * Drizzle schema — the single source of truth for the database (drizzle-kit
 * owns migrations; see drizzle.config.ts + ./drizzle).
 *
 * Conventions that keep this aligned with the rest of the codebase:
 *  - TS keys are snake_case (== column names) so the existing snake_case row
 *    shapes in src/types/db.ts and the insert/read objects carry over verbatim.
 *  - timestamptz columns use `mode: 'string'` → reads return ISO strings (what
 *    the UI + server-fn JSON contracts expect), writes accept ISO strings.
 *  - numeric columns use `mode: 'number'` → reads return JS numbers (postgres-js
 *    otherwise hands back strings, which would break the cost/stat arithmetic).
 *
 * Security model: app-enforced user_id scoping. Drizzle connects as the DB owner
 * (RLS bypassed), and every query filters by user_id. We still `enableRLS()` on
 * every table so the PUBLIC anon key cannot read these tables via Supabase's
 * auto-generated PostgREST API (RLS-on + no policy = deny for anon/authenticated).
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { Json } from '../types/db'

// Supabase Auth owns `auth.users`. Declare a minimal reference so we can express
// the FK; drizzle.config `schemaFilter: ['public']` keeps drizzle-kit from trying
// to create/drop the auth schema itself.
const authSchema = pgSchema('auth')
const authUsers = authSchema.table('users', {
  id: uuid('id').primaryKey(),
})

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })
const userId = () =>
  uuid('user_id')
    .notNull()
    .references(() => authUsers.id, { onDelete: 'cascade' })

export const teslaAccount = pgTable('tesla_account', {
  user_id: uuid('user_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  user_email: text('user_email'),
  fleet_api_base_url: text('fleet_api_base_url'),
  region: text('region'),
  linked_at: ts('linked_at'),
  created_at: ts('created_at').notNull().defaultNow(),
  updated_at: ts('updated_at').notNull().defaultNow(),
}).enableRLS()

export const teslaToken = pgTable('tesla_token', {
  user_id: uuid('user_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  access_token_enc: text('access_token_enc').notNull(),
  refresh_token_enc: text('refresh_token_enc').notNull(),
  access_token_expires_at: ts('access_token_expires_at').notNull(),
  scope: text('scope'),
  updated_at: ts('updated_at').notNull().defaultNow(),
}).enableRLS()

export const vehicle = pgTable(
  'vehicle',
  {
    vin: text('vin').primaryKey(),
    user_id: userId(),
    tesla_id: text('tesla_id').notNull(),
    vehicle_id: text('vehicle_id'),
    display_name: text('display_name'),
    car_type: text('car_type'),
    last_state: text('last_state'),
    created_at: ts('created_at').notNull().defaultNow(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('vehicle_user_idx').on(t.user_id)],
).enableRLS()

export const vehicleSnapshot = pgTable(
  'vehicle_snapshot',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    vin: text('vin')
      .notNull()
      .references(() => vehicle.vin, { onDelete: 'cascade' }),
    user_id: userId(),
    recorded_at: ts('recorded_at').notNull(),
    odometer: doublePrecision('odometer'),
    battery_level: integer('battery_level'),
    usable_battery_level: integer('usable_battery_level'),
    battery_range: doublePrecision('battery_range'),
    est_battery_range: doublePrecision('est_battery_range'),
    charge_energy_added: doublePrecision('charge_energy_added'),
    charging_state: text('charging_state'),
    charger_power: doublePrecision('charger_power'),
    shift_state: text('shift_state'),
    // Cabin temps (°C) + TPMS pressures (bar) — from climate_state / vehicle_state.
    inside_temp: doublePrecision('inside_temp'),
    outside_temp: doublePrecision('outside_temp'),
    tpms_fl: doublePrecision('tpms_fl'),
    tpms_fr: doublePrecision('tpms_fr'),
    tpms_rl: doublePrecision('tpms_rl'),
    tpms_rr: doublePrecision('tpms_rr'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    speed: doublePrecision('speed'),
    gps_as_of: ts('gps_as_of'),
    raw_json: jsonb('raw_json').$type<Json>(),
    created_at: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('vehicle_snapshot_vin_time_idx').on(t.vin, t.recorded_at.desc())],
).enableRLS()

export const chargeSession = pgTable(
  'charge_session',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    vin: text('vin')
      .notNull()
      .references(() => vehicle.vin, { onDelete: 'cascade' }),
    user_id: userId(),
    source: text('source').notNull().default('home'),
    started_at: ts('started_at').notNull(),
    ended_at: ts('ended_at'),
    location_name: text('location_name'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    energy_added_kwh: doublePrecision('energy_added_kwh'),
    miles_added_rated: doublePrecision('miles_added_rated'),
    // Geofence verdict (distinct from `source`/`cost_source`): home | away |
    // supercharger | unknown. Set at session close from the start lat/lng vs the
    // user's home geofence (and on billed rows by reconciliation → supercharger).
    charge_location_type: text('charge_location_type').notNull().default('unknown'),
    cost_amount: numeric('cost_amount', { precision: 12, scale: 4, mode: 'number' }),
    cost_currency: text('cost_currency'),
    cost_source: text('cost_source').notNull().default('computed'),
    rate_applied: numeric('rate_applied', { precision: 12, scale: 6, mode: 'number' }),
    tesla_charge_session_id: text('tesla_charge_session_id'),
    invoices: jsonb('invoices').$type<Json>(),
    created_at: ts('created_at').notNull().defaultNow(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('charge_session_vin_time_idx').on(t.vin, t.started_at.desc()),
    uniqueIndex('charge_session_tesla_id_uidx')
      .on(t.tesla_charge_session_id)
      .where(sql`${t.tesla_charge_session_id} is not null`),
    uniqueIndex('charge_session_open_uidx').on(t.vin).where(sql`${t.ended_at} is null`),
  ],
).enableRLS()

export const driveSession = pgTable(
  'drive_session',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    vin: text('vin')
      .notNull()
      .references(() => vehicle.vin, { onDelete: 'cascade' }),
    user_id: userId(),
    started_at: ts('started_at').notNull(),
    ended_at: ts('ended_at'),
    start_odometer: doublePrecision('start_odometer'),
    end_odometer: doublePrecision('end_odometer'),
    distance_mi: doublePrecision('distance_mi'),
    duration_s: integer('duration_s'),
    start_lat: doublePrecision('start_lat'),
    start_lng: doublePrecision('start_lng'),
    end_lat: doublePrecision('end_lat'),
    end_lng: doublePrecision('end_lng'),
    start_battery_level: integer('start_battery_level'),
    end_battery_level: integer('end_battery_level'),
    energy_used_kwh: doublePrecision('energy_used_kwh'),
    wh_per_mi: doublePrecision('wh_per_mi'),
    created_at: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('drive_session_vin_time_idx').on(t.vin, t.started_at.desc()),
    uniqueIndex('drive_session_open_uidx').on(t.vin).where(sql`${t.ended_at} is null`),
  ],
).enableRLS()

export const electricityRate = pgTable('electricity_rate', {
  user_id: uuid('user_id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('flat'),
  currency: text('currency').notNull().default('USD'),
  flat_rate: numeric('flat_rate', { precision: 12, scale: 6, mode: 'number' }),
  tou_schedule: jsonb('tou_schedule').$type<Json>(),
  loss_factor: numeric('loss_factor', { precision: 6, scale: 3, mode: 'number' })
    .notNull()
    .default(1.1),
  // Home geofence — co-located here because this row already owns the home-cost
  // inputs (flat_rate, loss_factor) and is one-row-per-user. Coordinates use
  // doublePrecision to match charge_session.lat/lng; radius in metres.
  home_lat: doublePrecision('home_lat'),
  home_lng: doublePrecision('home_lng'),
  home_radius_m: numeric('home_radius_m', { precision: 8, scale: 1, mode: 'number' }).default(150),
  // Nightly charge target (%) for the departure-readiness recommendation.
  departure_target_soc: integer('departure_target_soc'),
  effective_from: ts('effective_from').notNull().defaultNow(),
  updated_at: ts('updated_at').notNull().defaultNow(),
}).enableRLS()

// Notify-only anomaly flags (slow charge, efficiency drop). Detected in the
// poller at session/drive close; surfaced in-app. Normalized into its own table
// so thresholds can be re-tuned without schema churn and dismissal state stays
// out of the fact tables. The partial unique indexes make detection idempotent
// (one flag of a given type per source row, even under overlapping poll cycles).
export const anomalyFlag = pgTable(
  'anomaly_flag',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    vin: text('vin')
      .notNull()
      .references(() => vehicle.vin, { onDelete: 'cascade' }),
    user_id: userId(),
    type: text('type').notNull(), // 'slow_charge' | 'efficiency_drop'
    severity: text('severity').notNull().default('info'), // 'info' | 'warning'
    message: text('message').notNull(),
    related_charge_id: bigint('related_charge_id', { mode: 'number' }).references(
      () => chargeSession.id,
      { onDelete: 'cascade' },
    ),
    related_drive_id: bigint('related_drive_id', { mode: 'number' }).references(
      () => driveSession.id,
      { onDelete: 'cascade' },
    ),
    observed: numeric('observed', { precision: 12, scale: 4, mode: 'number' }),
    baseline: numeric('baseline', { precision: 12, scale: 4, mode: 'number' }),
    detail: jsonb('detail').$type<Json>(),
    created_at: ts('created_at').notNull().defaultNow(),
    dismissed_at: ts('dismissed_at'),
  },
  (t) => [
    index('anomaly_flag_user_time_idx').on(t.user_id, t.created_at.desc()),
    uniqueIndex('anomaly_flag_charge_uidx')
      .on(t.type, t.related_charge_id)
      .where(sql`${t.related_charge_id} is not null`),
    uniqueIndex('anomaly_flag_drive_uidx')
      .on(t.type, t.related_drive_id)
      .where(sql`${t.related_drive_id} is not null`),
  ],
).enableRLS()

export const teslaChargingHistoryImport = pgTable('tesla_charging_history_import', {
  vin: text('vin')
    .primaryKey()
    .references(() => vehicle.vin, { onDelete: 'cascade' }),
  user_id: userId(),
  last_page: integer('last_page').notNull().default(0),
  last_run_at: ts('last_run_at'),
}).enableRLS()
