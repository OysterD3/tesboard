/** Subset of Tesla Fleet API response shapes the dashboard consumes. */

export interface TeslaTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  id_token?: string
  scope?: string
}

export interface TeslaRegionResponse {
  response: {
    region: string
    fleet_api_base_url: string
  }
}

export interface TeslaVehicleListItem {
  id: number
  vehicle_id: number
  vin: string
  display_name: string | null
  state: 'online' | 'asleep' | 'offline' | string
  car_type?: string
}

export interface TeslaChargeState {
  battery_level?: number
  usable_battery_level?: number
  battery_range?: number
  est_battery_range?: number
  charge_energy_added?: number
  charge_miles_added_rated?: number
  charging_state?: string
  charger_power?: number
  charger_voltage?: number
}

export interface TeslaDriveState {
  latitude?: number
  longitude?: number
  speed?: number | null
  shift_state?: string | null
  gps_as_of?: number
  /** Drive-state reading time, Unix epoch in **milliseconds**. */
  timestamp?: number
  power?: number
}

export interface TeslaVehicleState {
  odometer?: number
  car_version?: string
  // TPMS pressures are reported in bar.
  tpms_pressure_fl?: number | null
  tpms_pressure_fr?: number | null
  tpms_pressure_rl?: number | null
  tpms_pressure_rr?: number | null
}

export interface TeslaClimateState {
  // Cabin temperatures are reported in °C.
  inside_temp?: number | null
  outside_temp?: number | null
}

export interface TeslaGuiSettings {
  gui_distance_units?: string // "mi/hr" | "km/hr"
}

export interface TeslaVehicleData {
  id: number
  vin: string
  state?: string
  charge_state?: TeslaChargeState
  drive_state?: TeslaDriveState
  vehicle_state?: TeslaVehicleState
  climate_state?: TeslaClimateState
  gui_settings?: TeslaGuiSettings
}

/** /api/1/dx/charging/history line item (Supercharger / Tesla-billed). */
export interface TeslaChargingHistoryFee {
  feeType?: string
  currencyCode?: string
  uom?: string
  usageBase?: number // kWh when uom === 'kWh'
  totalDue?: number
}

export interface TeslaChargingHistoryRecord {
  sessionId?: number | string
  vin?: string
  chargeStartDateTime?: string
  chargeStopDateTime?: string
  siteLocationName?: string
  fees?: TeslaChargingHistoryFee[]
}
