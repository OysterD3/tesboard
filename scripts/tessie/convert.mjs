/**
 * Pure helpers for the Tessie CSV importer (scripts/import-tessie.mjs).
 *
 * Tessie exports one CSV per telemetry stream (battery / charging / climate /
 * vehicle / driving), each a raw per-sample time-series — there are NO
 * pre-computed drive/charge summaries (unlike TeslaMate). So this module owns:
 *   - CSV parsing + Tessie timestamp/number coercion,
 *   - sessionization (turning a sample stream into drive/charge runs the way
 *     src/server/poller.ts does), and
 *   - the cost / geofence / efficiency math, ported VERBATIM from
 *     src/server/{cost,geo,efficiency}.ts so an import closes a session
 *     identically to the live poller. Those .ts modules can't be imported from a
 *     plain-node .mjs script, hence the copy. Keep them in sync if the originals
 *     change.
 *
 * Everything here is pure (no DB / IO) and unit-tested in ./convert.test.ts.
 *
 * Units note: Tessie data is ALREADY imperial (miles, mph) and °C / bar — the
 * same units tesboard stores — so unlike the TeslaMate importer there are no
 * km→mi conversions here.
 */

// ── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Minimal RFC-4180-ish CSV parser. Handles double-quoted fields, escaped quotes
 * (""), CRLF/LF, and bare empty fields (`,,`). Returns { header, rows } where
 * every cell is a string ('' for empty); callers coerce via num()/str().
 */
export function parseCsv(text) {
  const rows = []
  let field = ''
  let row = []
  let i = 0
  let inQuotes = false
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (c === '\n' || c === '\r') {
      // end of line; consume \r\n as one
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      // skip fully-empty trailing lines
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
      i++
      continue
    }
    field += c
    i++
  }
  // flush last field/row (no trailing newline)
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
  }
  const header = rows.shift() ?? []
  return { header, rows }
}

/** '' / null → null; otherwise a finite number or null. */
export function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Round to an integer or null (for integer columns: SOC, voltage, current). */
export function toInt(v) {
  const n = num(v)
  return n == null ? null : Math.round(n)
}

/** Tessie boolean cell ("1"/"0"/"true"/"") → boolean or null. */
export function toBool(v) {
  if (v == null || v === '') return null
  if (v === '1' || v === 'true' || v === 'True') return true
  if (v === '0' || v === 'false' || v === 'False') return false
  const n = Number(v)
  return Number.isFinite(n) ? n !== 0 : null
}

// ── Tessie timestamps ────────────────────────────────────────────────────────
// Tessie stamps are UTC wall-clock "YYYY-MM-DD HH:MM:SS" (no zone). Treat as UTC.

/** "2026-02-15 09:56:14" → "2026-02-15T09:56:14Z" (or null). */
export function tessieTsToIso(ts) {
  if (!ts) return null
  const m = String(ts)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/)
  if (!m) return null
  return `${m[1]}T${m[2]}Z`
}

/** Tessie stamp → epoch ms (UTC), or null. */
export function tessieTsToMs(ts) {
  const iso = tessieTsToIso(ts)
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/** epoch ms → ISO string with trailing Z (second precision). */
export function msToIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ── Sessionization ───────────────────────────────────────────────────────────

/**
 * Turn an ordered sample stream into maximal active runs — the importer's
 * equivalent of the poller's open/close transitions (poller.ts:443-477 drives,
 * 245-295 charges).
 *
 * `samples` must be sorted ascending and each carry a `.ms` (epoch ms).
 * `isActive(sample)` decides membership (e.g. shift ∈ {D,R,N}, or state ===
 * 'Charging'). A run ENDS at the first following inactive sample (its ms becomes
 * `closeMs`, mirroring the poller closing on the first non-matching poll), OR is
 * stale-closed at the last active sample when the next sample is > `maxGapMs`
 * away or the stream ends (poller.ts reapStaleSessions, 6h default).
 *
 * Returns [{ startIdx, endIdx, startMs, endMs, closeMs }] where start/endIdx
 * bound the ACTIVE samples, endMs = last active sample, closeMs = ended_at.
 */
export function sessionizeRuns(samples, isActive, maxGapMs) {
  const runs = []
  let startIdx = -1
  let endIdx = -1
  const finalize = (closeSample) => {
    const startMs = samples[startIdx].ms
    const endMs = samples[endIdx].ms
    let closeMs = endMs
    if (closeSample && closeSample.ms - endMs <= maxGapMs) closeMs = closeSample.ms
    runs.push({ startIdx, endIdx, startMs, endMs, closeMs })
  }
  for (let i = 0; i < samples.length; i++) {
    if (isActive(samples[i])) {
      if (startIdx === -1) {
        startIdx = i
        endIdx = i
      } else if (samples[i].ms - samples[endIdx].ms > maxGapMs) {
        // gap inside an active run → stale-close the old run, start a new one
        finalize(null)
        startIdx = i
        endIdx = i
      } else {
        endIdx = i
      }
    } else if (startIdx !== -1) {
      finalize(samples[i])
      startIdx = -1
      endIdx = -1
    }
  }
  if (startIdx !== -1) finalize(null)
  return runs
}

// ── Aggregation primitives (over a window slice) ─────────────────────────────

export function firstNonNull(values) {
  for (const v of values) if (v != null) return v
  return null
}
export function lastNonNull(values) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i]
  return null
}
export function avgNonNull(values) {
  let sum = 0
  let n = 0
  for (const v of values) {
    if (v != null) {
      sum += v
      n++
    }
  }
  return n > 0 ? sum / n : null
}
export function maxNonNull(values) {
  let m = null
  for (const v of values) if (v != null && (m == null || v > m)) m = v
  return m
}

/** Positive delta a−b (energy consumed / range dropped) or null. */
export function positiveDelta(a, b) {
  if (a == null || b == null) return null
  const d = a - b
  return d > 0 ? d : null
}

export function clamp(v, lo, hi) {
  if (v == null) return null
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Wh/mi from drive energy + distance. Ported from scripts/teslamate/convert.mjs
 * whPerMi: guards energy>0 and distance ≥ 1 mi (sub-mile quantization noise →
 * null), matching poller.ts MIN_WHPM_DISTANCE_MI.
 */
export function whPerMi(energyKwh, distanceMi) {
  if (energyKwh == null || distanceMi == null) return null
  if (energyKwh <= 0 || distanceMi < 1) return null
  return (energyKwh * 1000) / distanceMi
}

/** SOC-delta × pack fallback for drive energy (poller.ts:533-536). */
export function socEnergyKwh(startBl, endBl, packKwh) {
  if (startBl == null || endBl == null || packKwh == null) return null
  const raw = ((startBl - endBl) / 100) * packKwh
  return raw >= 0 ? raw : null
}

/**
 * Median usable pack kWh from (SOC%, energyRemainingKwh) samples, using only the
 * stable middle of the curve (25–90%) to avoid the top/bottom buffer regions.
 */
export function derivePackKwh(pairs) {
  const est = []
  for (const { socPct, remainingKwh } of pairs) {
    if (socPct != null && remainingKwh != null && socPct >= 25 && socPct <= 90 && remainingKwh > 0) {
      est.push(remainingKwh / (socPct / 100))
    }
  }
  if (!est.length) return null
  est.sort((a, b) => a - b)
  return est[Math.floor(est.length / 2)]
}

// ── Efficiency — VERBATIM from src/server/efficiency.ts ───────────────────────

const RETRY = [
  [3, 8],
  [3, 5],
  [2, 5],
  [2, 3],
  [1, 3],
  [1, 2],
]

/** Derive Wh/mi from clean charge samples (mode, then median). Null if no signal. */
export function deriveEfficiencyWhPerMi(samples) {
  const factors = samples
    .filter((s) => s.rangeAddedMi > 0 && s.energyKwh > 0)
    .map((s) => s.energyKwh / s.rangeAddedMi) // kWh per mile
  if (!factors.length) return null

  for (const [precision, minCount] of RETRY) {
    const counts = new Map()
    for (const f of factors) {
      const key = f.toFixed(precision)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    let bestKey = null
    let best = 0
    for (const [k, c] of counts) {
      if (c > best) {
        best = c
        bestKey = k
      }
    }
    if (bestKey != null && best >= minCount) return Number(bestKey) * 1000
  }

  const sorted = [...factors].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return median * 1000
}

// ── Geo — VERBATIM from src/server/geo.ts ────────────────────────────────────

const EARTH_RADIUS_M = 6_371_000
const DEFAULT_HOME_RADIUS_M = 150

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function findGeofence(lat, lng, geofences) {
  if (lat == null || lng == null) return null
  let best = null
  let bestDist = Infinity
  for (const g of geofences) {
    if (g.lat == null || g.lng == null) continue
    const radius = g.radius_m ?? DEFAULT_HOME_RADIUS_M
    const d = haversineMeters(lat, lng, g.lat, g.lng)
    if (d <= radius && d < bestDist) {
      best = g
      bestDist = d
    }
  }
  return best
}

export function classifyChargeLocation(source, lat, lng, home) {
  if (source === 'supercharger') return 'supercharger'
  if (lat == null || lng == null) return 'unknown'
  if (!home || home.home_lat == null || home.home_lng == null) return 'unknown'
  const radius = home.home_radius_m ?? DEFAULT_HOME_RADIUS_M
  const d = haversineMeters(lat, lng, home.home_lat, home.home_lng)
  return d <= radius ? 'home' : 'away'
}

// ── Cost — VERBATIM from src/server/cost.ts ──────────────────────────────────

const NONE = { cost_amount: null, cost_currency: null, cost_source: 'computed', rate_applied: null }

function bandCovers(band, dow, m) {
  if (band.days && band.days.length > 0 && !band.days.includes(dow)) return false
  const { startMin, endMin } = band
  if (startMin === endMin) return true
  return startMin < endMin ? m >= startMin && m < endMin : m >= startMin || m < endMin
}

function rateAtInstant(schedule, utcMs) {
  const localMs = utcMs + (schedule.utcOffsetMin ?? 0) * 60_000
  const d = new Date(localMs)
  const dow = d.getUTCDay()
  const m = d.getUTCHours() * 60 + d.getUTCMinutes()
  for (const b of schedule.bands) if (bandCovers(b, dow, m)) return b.rate
  return schedule.defaultRate ?? null
}

export function touWeightedRate(schedule, startISO, endISO) {
  if (!startISO) return null
  const startMs = new Date(startISO).getTime()
  if (Number.isNaN(startMs)) return null
  const endMs = endISO ? new Date(endISO).getTime() : startMs
  const totalMin = Math.max(1, Math.round((endMs - startMs) / 60_000))
  const cap = Math.min(totalMin, 14 * 24 * 60)
  let sum = 0
  let n = 0
  for (let i = 0; i < cap; i++) {
    const r = rateAtInstant(schedule, startMs + i * 60_000)
    if (r != null) {
      sum += r
      n++
    }
  }
  return n > 0 ? sum / n : null
}

export function parseTouSchedule(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const obj = json
  const rawBands = Array.isArray(obj.bands) ? obj.bands : []
  const bands = []
  for (const b of rawBands) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue
    const o = b
    const rate = typeof o.rate === 'number' ? o.rate : Number(o.rate)
    const startMin = typeof o.startMin === 'number' ? o.startMin : Number(o.startMin)
    const endMin = typeof o.endMin === 'number' ? o.endMin : Number(o.endMin)
    if (![rate, startMin, endMin].every((n) => Number.isFinite(n))) continue
    const days = Array.isArray(o.days)
      ? o.days.filter((d) => typeof d === 'number' && d >= 0 && d <= 6)
      : undefined
    bands.push({ name: typeof o.name === 'string' ? o.name : 'Band', rate, startMin, endMin, days })
  }
  const defaultRate = typeof obj.defaultRate === 'number' ? obj.defaultRate : null
  if (bands.length === 0 && defaultRate == null) return null
  const utcOffsetMin = typeof obj.utcOffsetMin === 'number' ? obj.utcOffsetMin : 0
  return { bands, defaultRate, utcOffsetMin }
}

function billableEnergy(addedKwh, usedKwh) {
  if (usedKwh != null && addedKwh != null) return Math.max(usedKwh, addedKwh)
  return usedKwh ?? addedKwh ?? null
}

export function computeChargeCost(input) {
  const { source, geofence, homeRate } = input

  if (source === 'supercharger') {
    if (input.freeSupercharging) {
      return {
        cost_amount: 0,
        cost_currency: geofence?.currency ?? homeRate?.currency ?? null,
        cost_source: 'tesla_billed_free',
        rate_applied: 0,
      }
    }
    return NONE
  }

  if (geofence && geofence.cost_per_unit != null) {
    const rate = Number(geofence.cost_per_unit)
    const fee = geofence.session_fee != null ? Number(geofence.session_fee) : 0
    const currency = geofence.currency ?? homeRate?.currency ?? null
    if (geofence.billing_type === 'per_minute') {
      const minutes = input.durationS != null ? input.durationS / 60 : null
      const amount = minutes != null ? minutes * rate + fee : null
      return { cost_amount: amount, cost_currency: currency, cost_source: 'geofence', rate_applied: rate }
    }
    if (geofence.billing_type === 'per_session') {
      return { cost_amount: fee, cost_currency: currency, cost_source: 'geofence', rate_applied: null }
    }
    const energy = billableEnergy(input.energyAddedKwh, input.energyUsedKwh)
    const amount = energy != null ? energy * rate + fee : null
    return { cost_amount: amount, cost_currency: currency, cost_source: 'geofence', rate_applied: rate }
  }

  if (geofence && geofence.session_fee != null) {
    return {
      cost_amount: Number(geofence.session_fee),
      cost_currency: geofence.currency ?? homeRate?.currency ?? null,
      cost_source: 'geofence',
      rate_applied: null,
    }
  }

  const home = geofence?.is_home || input.isHome
  if (home && homeRate && input.energyAddedKwh) {
    const loss = Number(homeRate.loss_factor ?? 1.1)

    if (homeRate.tou) {
      const weighted = touWeightedRate(homeRate.tou, input.startedAt, input.endedAt)
      if (weighted != null) {
        return {
          cost_amount: input.energyAddedKwh * weighted * loss,
          cost_currency: homeRate.currency ?? null,
          cost_source: 'computed',
          rate_applied: Math.round(weighted * 1e6) / 1e6,
        }
      }
    }

    if (homeRate.flat_rate != null) {
      const rate = Number(homeRate.flat_rate)
      return {
        cost_amount: input.energyAddedKwh * rate * loss,
        cost_currency: homeRate.currency ?? null,
        cost_source: 'computed',
        rate_applied: rate,
      }
    }
  }

  return NONE
}

// ── State timeline ───────────────────────────────────────────────────────────

/**
 * Build vehicle_state intervals from the merged sample timeline. Tessie has no
 * explicit online/asleep stream, so we infer: a gap > `sleepGapMs` between
 * consecutive samples = 'asleep' (the car stopped reporting); otherwise the
 * interval is 'driving' / 'charging' (when `classify(ms)` says so) or 'online'.
 * Adjacent equal-state intervals are merged. `msList` must be sorted ascending.
 */
export function deriveStates(msList, classify, sleepGapMs) {
  const intervals = []
  const push = (state, startMs, endMs) => {
    const prev = intervals[intervals.length - 1]
    if (prev && prev.state === state && prev.endMs === startMs) prev.endMs = endMs
    else intervals.push({ state, startMs, endMs })
  }
  for (let i = 0; i < msList.length - 1; i++) {
    const a = msList[i]
    const b = msList[i + 1]
    if (b - a > sleepGapMs) push('asleep', a, b)
    else push(classify(a) ?? 'online', a, b)
  }
  return intervals
}
