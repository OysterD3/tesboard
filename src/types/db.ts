/**
 * Row shapes for the Supabase tables (see supabase/migrations/0001_init.sql).
 * Hand-maintained; keep in sync with the migration. Safe to import anywhere
 * (types only, no runtime).
 */

/** JSON-serializable value (TanStack Start server fns require serializable returns). */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[]

export type ChargingState =
  | 'Disconnected'
  | 'Charging'
  | 'Complete'
  | 'Stopped'
  | 'NoPower'
  | (string & {})

export type ShiftState = 'P' | 'R' | 'N' | 'D' | null

export type ChargeSource = 'supercharger' | 'home' | 'other'
export type CostSource =
  | 'computed'
  | 'tesla_billed'
  | 'tesla_billed_free'
  | 'imported_teslamate'
  | 'geofence'
export type ChargeLocationType = 'home' | 'away' | 'supercharger' | 'unknown'
export type BillingType = 'per_kwh' | 'per_minute' | 'per_session'
export type VehicleStateKind = 'online' | 'asleep' | 'offline' | 'driving' | 'charging'

export type AnomalyType = 'slow_charge' | 'efficiency_drop'
export type AnomalySeverity = 'info' | 'warning'

export interface TeslaAccount {
  user_id: string
  user_email: string | null
  fleet_api_base_url: string | null
  region: string | null
  linked_at: string | null
  created_at: string
  updated_at: string
}

export interface Vehicle {
  vin: string
  user_id: string
  tesla_id: string
  vehicle_id: string | null
  display_name: string | null
  car_type: string | null
  last_state: string | null
  model: string | null
  trim_badging: string | null
  marketing_name: string | null
  exterior_color: string | null
  wheel_type: string | null
  spoiler_type: string | null
  pack_kwh: number | null
  efficiency_wh_per_mi: number | null
  is_lfp: boolean
  free_supercharging: boolean
  display_priority: number
  created_at: string
  updated_at: string
}

export interface VehicleSnapshot {
  id: number
  vin: string
  user_id: string
  recorded_at: string
  odometer: number | null
  battery_level: number | null
  usable_battery_level: number | null
  battery_range: number | null
  est_battery_range: number | null
  charge_energy_added: number | null
  charging_state: ChargingState | null
  charger_power: number | null
  shift_state: ShiftState
  inside_temp: number | null
  outside_temp: number | null
  tpms_fl: number | null
  tpms_fr: number | null
  tpms_rl: number | null
  tpms_rr: number | null
  latitude: number | null
  longitude: number | null
  speed: number | null
  charger_voltage: number | null
  charger_actual_current: number | null
  charger_phases: number | null
  power_kw: number | null
  elevation_m: number | null
  gps_as_of: string | null
  raw_json: Json | null
  source_drive_id: number | null
  source_charge_id: number | null
  import_source: string
  source_pk: number | null
  created_at: string
}

export interface ChargeSession {
  id: number
  vin: string
  user_id: string
  source: ChargeSource
  started_at: string
  ended_at: string | null
  location_name: string | null
  lat: number | null
  lng: number | null
  energy_added_kwh: number | null
  energy_used_kwh: number | null
  miles_added_rated: number | null
  start_range_mi: number | null
  end_range_mi: number | null
  start_battery_level: number | null
  end_battery_level: number | null
  outside_temp_avg: number | null
  fast_charger_type: string | null
  charge_location_type: ChargeLocationType
  geofence_id: number | null
  address_id: number | null
  cost_amount: number | null
  cost_currency: string | null
  cost_source: CostSource
  rate_applied: number | null
  tesla_charge_session_id: string | null
  invoices: Json | null
  import_source: string
  source_pk: number | null
  created_at: string
  updated_at: string
}

export interface DriveSession {
  id: number
  vin: string
  user_id: string
  started_at: string
  ended_at: string | null
  start_odometer: number | null
  end_odometer: number | null
  distance_mi: number | null
  duration_s: number | null
  start_lat: number | null
  start_lng: number | null
  end_lat: number | null
  end_lng: number | null
  start_battery_level: number | null
  end_battery_level: number | null
  start_range_mi: number | null
  end_range_mi: number | null
  energy_used_kwh: number | null
  wh_per_mi: number | null
  outside_temp_avg: number | null
  inside_temp_avg: number | null
  speed_max_mph: number | null
  power_max_kw: number | null
  power_min_kw: number | null
  ascent: number | null
  descent: number | null
  start_snapshot_id: number | null
  end_snapshot_id: number | null
  start_address_id: number | null
  end_address_id: number | null
  start_geofence_id: number | null
  end_geofence_id: number | null
  import_source: string
  source_pk: number | null
  created_at: string
}

export interface ElectricityRate {
  user_id: string
  kind: 'flat' | 'tou'
  currency: string
  flat_rate: number | null
  tou_schedule: Json | null
  loss_factor: number
  home_lat: number | null
  home_lng: number | null
  home_radius_m: number | null
  departure_target_soc: number | null
  effective_from: string
  updated_at: string
}

export interface AnomalyFlag {
  id: number
  vin: string
  user_id: string
  type: AnomalyType
  severity: AnomalySeverity
  message: string
  related_charge_id: number | null
  related_drive_id: number | null
  observed: number | null
  baseline: number | null
  detail: Json | null
  created_at: string
  dismissed_at: string | null
}

export interface Geofence {
  id: number
  user_id: string
  name: string
  lat: number | null
  lng: number | null
  radius_m: number
  billing_type: BillingType
  cost_per_unit: number | null
  session_fee: number | null
  currency: string | null
  is_home: boolean
  source_pk: number | null
  created_at: string
  updated_at: string
}

export interface Address {
  id: number
  user_id: string
  osm_id: number | null
  osm_type: string | null
  display_name: string | null
  name: string | null
  house_number: string | null
  road: string | null
  neighbourhood: string | null
  city: string | null
  county: string | null
  postcode: string | null
  state: string | null
  state_district: string | null
  country: string | null
  lat: number | null
  lng: number | null
  raw_json: Json | null
  geofence_id: number | null
  source_pk: number | null
  created_at: string
}

export interface VehicleState {
  id: number
  vin: string
  user_id: string
  state: VehicleStateKind | (string & {})
  started_at: string
  ended_at: string | null
  import_source: string
  source_pk: number | null
}

export interface SoftwareUpdate {
  id: number
  vin: string
  user_id: string
  version: string | null
  started_at: string
  ended_at: string | null
  import_source: string
  source_pk: number | null
  created_at: string
}

export interface ImportBatch {
  id: number
  user_id: string
  source: string
  status: string
  preferred_range: string | null
  cutover_at: string | null
  file_checksums: Json | null
  cursors: Json | null
  row_counts: Json | null
  error: string | null
  created_at: string
  finished_at: string | null
}
