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
  boolean,
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
    // Physical attributes (mostly populated from a TeslaMate import or set in
    // settings). These replace the old global PACK_KWH=75 constant in poller.ts.
    model: text('model'),
    trim_badging: text('trim_badging'),
    marketing_name: text('marketing_name'),
    exterior_color: text('exterior_color'),
    wheel_type: text('wheel_type'),
    spoiler_type: text('spoiler_type'),
    // Usable pack energy (kWh) and the derived efficiency factor (Wh per mile at
    // 100% — i.e. energy per rated mile), recomputed by src/server/efficiency.ts.
    pack_kwh: numeric('pack_kwh', { precision: 8, scale: 3, mode: 'number' }),
    efficiency_wh_per_mi: numeric('efficiency_wh_per_mi', { precision: 8, scale: 2, mode: 'number' }),
    is_lfp: boolean('is_lfp').notNull().default(false),
    free_supercharging: boolean('free_supercharging').notNull().default(false),
    display_priority: integer('display_priority').notNull().default(1),
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
    // Charge-curve detail (from charge_state / a TeslaMate `charges` import) and
    // instantaneous drive power + elevation (from a `positions` import). Live
    // polling fills voltage/current/phases when present; elevation is import-only.
    charger_voltage: integer('charger_voltage'),
    charger_actual_current: integer('charger_actual_current'),
    charger_phases: integer('charger_phases'),
    power_kw: doublePrecision('power_kw'),
    elevation_m: integer('elevation_m'),
    // Standby-drain cause signals (from vehicle_state / climate_state). Used to
    // attribute phantom/vampire loss while parked. Live-poll only; null on imports.
    sentry_mode: boolean('sentry_mode'),
    is_climate_on: boolean('is_climate_on'),
    is_preconditioning: boolean('is_preconditioning'),
    gps_as_of: ts('gps_as_of'),
    raw_json: jsonb('raw_json').$type<Json>(),
    // Provenance: 'live' for poller rows; 'teslamate_position' / 'teslamate_charge'
    // for imported sample streams. source_pk = the original TeslaMate row id.
    // source_drive_id / source_charge_id link an imported sample to its session.
    source_drive_id: bigint('source_drive_id', { mode: 'number' }),
    source_charge_id: bigint('source_charge_id', { mode: 'number' }),
    import_source: text('import_source').notNull().default('live'),
    source_pk: bigint('source_pk', { mode: 'number' }),
    created_at: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('vehicle_snapshot_vin_time_idx').on(t.vin, t.recorded_at.desc()),
    index('vehicle_snapshot_drive_idx').on(t.source_drive_id),
    index('vehicle_snapshot_charge_idx').on(t.source_charge_id),
    // Idempotent re-import: one row per (vin, stream, original id). The stream is
    // baked into import_source so a position and a charge sharing an id never clash.
    uniqueIndex('vehicle_snapshot_import_uidx')
      .on(t.vin, t.import_source, t.source_pk)
      .where(sql`${t.source_pk} is not null`),
  ],
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
    // Grid-side energy (>= energy_added; AC losses + phase correction). Import-only
    // for now — live polling has no V/A/phase to derive it.
    energy_used_kwh: doublePrecision('energy_used_kwh'),
    miles_added_rated: doublePrecision('miles_added_rated'),
    start_range_mi: doublePrecision('start_range_mi'),
    end_range_mi: doublePrecision('end_range_mi'),
    start_battery_level: integer('start_battery_level'),
    end_battery_level: integer('end_battery_level'),
    outside_temp_avg: doublePrecision('outside_temp_avg'), // °C
    fast_charger_type: text('fast_charger_type'),
    // Geofence verdict (distinct from `source`/`cost_source`): home | away |
    // supercharger | unknown. Set at session close from the start lat/lng vs the
    // user's home geofence (and on billed rows by reconciliation → supercharger).
    charge_location_type: text('charge_location_type').notNull().default('unknown'),
    // Resolved geofence + reverse-geocoded address (app-enforced links, not FKs).
    geofence_id: bigint('geofence_id', { mode: 'number' }),
    address_id: bigint('address_id', { mode: 'number' }),
    cost_amount: numeric('cost_amount', { precision: 12, scale: 4, mode: 'number' }),
    cost_currency: text('cost_currency'),
    // 'computed' | 'tesla_billed' | 'tesla_billed_free' | 'imported_teslamate' | 'geofence'.
    cost_source: text('cost_source').notNull().default('computed'),
    rate_applied: numeric('rate_applied', { precision: 12, scale: 6, mode: 'number' }),
    tesla_charge_session_id: text('tesla_charge_session_id'),
    invoices: jsonb('invoices').$type<Json>(),
    import_source: text('import_source').notNull().default('live'),
    source_pk: bigint('source_pk', { mode: 'number' }),
    created_at: ts('created_at').notNull().defaultNow(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('charge_session_vin_time_idx').on(t.vin, t.started_at.desc()),
    uniqueIndex('charge_session_tesla_id_uidx')
      .on(t.tesla_charge_session_id)
      .where(sql`${t.tesla_charge_session_id} is not null`),
    uniqueIndex('charge_session_open_uidx').on(t.vin).where(sql`${t.ended_at} is null`),
    // Idempotent import: one imported charge per (vin, started_at). Scoped to
    // imported rows so it never collides with live sessionization.
    uniqueIndex('charge_session_import_uidx')
      .on(t.vin, t.started_at)
      .where(sql`${t.import_source} <> 'live'`),
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
    start_range_mi: doublePrecision('start_range_mi'),
    end_range_mi: doublePrecision('end_range_mi'),
    energy_used_kwh: doublePrecision('energy_used_kwh'),
    wh_per_mi: doublePrecision('wh_per_mi'),
    outside_temp_avg: doublePrecision('outside_temp_avg'), // °C
    inside_temp_avg: doublePrecision('inside_temp_avg'), // °C
    speed_max_mph: integer('speed_max_mph'),
    power_max_kw: integer('power_max_kw'),
    power_min_kw: integer('power_min_kw'),
    ascent: integer('ascent'), // metres
    descent: integer('descent'), // metres
    // App-enforced links (not FKs): endpoint snapshots, addresses, geofences.
    start_snapshot_id: bigint('start_snapshot_id', { mode: 'number' }),
    end_snapshot_id: bigint('end_snapshot_id', { mode: 'number' }),
    start_address_id: bigint('start_address_id', { mode: 'number' }),
    end_address_id: bigint('end_address_id', { mode: 'number' }),
    start_geofence_id: bigint('start_geofence_id', { mode: 'number' }),
    end_geofence_id: bigint('end_geofence_id', { mode: 'number' }),
    import_source: text('import_source').notNull().default('live'),
    source_pk: bigint('source_pk', { mode: 'number' }),
    created_at: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('drive_session_vin_time_idx').on(t.vin, t.started_at.desc()),
    uniqueIndex('drive_session_open_uidx').on(t.vin).where(sql`${t.ended_at} is null`),
    uniqueIndex('drive_session_import_uidx')
      .on(t.vin, t.started_at)
      .where(sql`${t.import_source} <> 'live'`),
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

// Named circular zones with per-zone cost rules. Generalizes the single home
// geofence stored on electricity_rate (home_lat/lng/radius/flat_rate). The Home
// zone is seeded from electricity_rate so existing cost behaviour carries over.
export const geofence = pgTable(
  'geofence',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    user_id: userId(),
    name: text('name').notNull(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    radius_m: numeric('radius_m', { precision: 8, scale: 1, mode: 'number' }).notNull().default(150),
    // 'per_kwh' | 'per_minute' | 'per_session'
    billing_type: text('billing_type').notNull().default('per_kwh'),
    cost_per_unit: numeric('cost_per_unit', { precision: 12, scale: 6, mode: 'number' }),
    session_fee: numeric('session_fee', { precision: 12, scale: 4, mode: 'number' }),
    currency: text('currency'),
    // True for the user's home zone (seeds/syncs electricity_rate.home_*).
    is_home: boolean('is_home').notNull().default(false),
    source_pk: bigint('source_pk', { mode: 'number' }),
    created_at: ts('created_at').notNull().defaultNow(),
    updated_at: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('geofence_user_idx').on(t.user_id),
    uniqueIndex('geofence_name_uidx').on(t.user_id, sql`lower(${t.name})`),
  ],
).enableRLS()

// Reverse-geocoded place names (Nominatim/OSM), deduped on (osm_id, osm_type),
// which is also TeslaMate's natural dedup key.
export const address = pgTable(
  'address',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    user_id: userId(),
    osm_id: bigint('osm_id', { mode: 'number' }),
    osm_type: text('osm_type'),
    display_name: text('display_name'),
    name: text('name'),
    house_number: text('house_number'),
    road: text('road'),
    neighbourhood: text('neighbourhood'),
    city: text('city'),
    county: text('county'),
    postcode: text('postcode'),
    state: text('state'),
    state_district: text('state_district'),
    country: text('country'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    raw_json: jsonb('raw_json').$type<Json>(),
    geofence_id: bigint('geofence_id', { mode: 'number' }),
    source_pk: bigint('source_pk', { mode: 'number' }),
    created_at: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('address_user_idx').on(t.user_id),
    uniqueIndex('address_osm_uidx')
      .on(t.user_id, t.osm_id, t.osm_type)
      .where(sql`${t.osm_id} is not null`),
  ],
).enableRLS()

// State-interval history (online | asleep | offline | driving | charging),
// written by the poller on transition. Powers the States timeline + drain
// attribution. One open interval per vehicle at a time.
export const vehicleState = pgTable(
  'vehicle_state',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    vin: text('vin')
      .notNull()
      .references(() => vehicle.vin, { onDelete: 'cascade' }),
    user_id: userId(),
    state: text('state').notNull(),
    started_at: ts('started_at').notNull(),
    ended_at: ts('ended_at'),
    import_source: text('import_source').notNull().default('live'),
    source_pk: bigint('source_pk', { mode: 'number' }),
  },
  (t) => [
    index('vehicle_state_vin_time_idx').on(t.vin, t.started_at.desc()),
    uniqueIndex('vehicle_state_open_uidx').on(t.vin).where(sql`${t.ended_at} is null`),
    uniqueIndex('vehicle_state_start_uidx').on(t.vin, t.started_at),
  ],
).enableRLS()

// Firmware version history. ended_at is the (cadence-bounded) install boundary.
export const softwareUpdate = pgTable(
  'software_update',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    vin: text('vin')
      .notNull()
      .references(() => vehicle.vin, { onDelete: 'cascade' }),
    user_id: userId(),
    version: text('version'),
    started_at: ts('started_at').notNull(),
    ended_at: ts('ended_at'),
    import_source: text('import_source').notNull().default('live'),
    source_pk: bigint('source_pk', { mode: 'number' }),
    created_at: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('software_update_vin_time_idx').on(t.vin, t.started_at.desc()),
    uniqueIndex('software_update_uidx').on(t.vin, t.started_at, t.version),
  ],
).enableRLS()

// One row per TeslaMate import run. Makes the import resumable + lets a
// re-uploaded identical export detect "already imported" via checksum.
export const importBatch = pgTable('import_batch', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  user_id: userId(),
  source: text('source').notNull().default('teslamate'),
  status: text('status').notNull().default('running'),
  preferred_range: text('preferred_range'),
  cutover_at: ts('cutover_at'),
  file_checksums: jsonb('file_checksums').$type<Json>(),
  cursors: jsonb('cursors').$type<Json>(),
  row_counts: jsonb('row_counts').$type<Json>(),
  error: text('error'),
  created_at: ts('created_at').notNull().defaultNow(),
  finished_at: ts('finished_at'),
}).enableRLS()

// Transient bridge: TeslaMate integer PK → tesboard identity PK (or vehicle.vin)
// during a single import batch. Prunable after finalize.
export const importPkMap = pgTable(
  'import_pk_map',
  {
    import_batch_id: bigint('import_batch_id', { mode: 'number' }).notNull(),
    user_id: userId(),
    entity: text('entity').notNull(),
    old_id: bigint('old_id', { mode: 'number' }).notNull(),
    new_id: bigint('new_id', { mode: 'number' }),
    new_vin: text('new_vin'),
  },
  (t) => [
    uniqueIndex('import_pk_map_uidx').on(t.import_batch_id, t.entity, t.old_id),
  ],
).enableRLS()
