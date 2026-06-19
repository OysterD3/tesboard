import { describe, expect, it } from 'vitest'
import { fmtDay } from './units'

describe('fmtDay', () => {
  it('formats a YYYY-MM-DD day as "Mon D"', () => {
    expect(fmtDay('2026-06-18')).toBe('Jun 18')
    expect(fmtDay('2026-01-01')).toBe('Jan 1')
    expect(fmtDay('2026-12-31')).toBe('Dec 31')
  })

  it('does not zero-pad the day', () => {
    expect(fmtDay('2026-03-05')).toBe('Mar 5')
  })

  it('is timezone- and locale-independent (no Date/Intl dependency)', () => {
    // A fixed table means the output can never shift under a runtime locale or
    // timezone — the source of the React #418 hydration class this guards.
    const prev = process.env.TZ
    process.env.TZ = 'Pacific/Kiritimati' // UTC+14
    try {
      expect(fmtDay('2026-06-18')).toBe('Jun 18')
    } finally {
      process.env.TZ = prev
    }
  })

  it('falls back to the raw string for out-of-range or unparseable input', () => {
    expect(fmtDay('2026-13-01')).toBe('2026-13-01') // month overflow
    expect(fmtDay('2026-02-32')).toBe('2026-02-32') // day overflow
    expect(fmtDay('2026-00-10')).toBe('2026-00-10') // zero month
    expect(fmtDay('not-a-date')).toBe('not-a-date')
    expect(fmtDay('')).toBe('')
  })

  it('never silently rolls an impossible day into the next month', () => {
    // The whole point of the fixed table: Date.UTC(2026, 1, 30) would shift to
    // Mar 2 — we render the literal "Feb 30" instead, never a wrong real date.
    expect(fmtDay('2026-02-30')).not.toContain('Mar')
  })
})
