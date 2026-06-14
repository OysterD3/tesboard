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
export type CostSource = 'tesla_billed' | 'computed'
export type ChargeLocationType = 'home' | 'away' | 'supercharger' | 'unknown'

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
  gps_as_of: string | null
  raw_json: Json | null
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
  miles_added_rated: number | null
  charge_location_type: ChargeLocationType
  cost_amount: number | null
  cost_currency: string | null
  cost_source: CostSource
  rate_applied: number | null
  tesla_charge_session_id: string | null
  invoices: Json | null
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
  energy_used_kwh: number | null
  wh_per_mi: number | null
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
