import { describe, expect, it } from 'vitest'
import { deriveEfficiencyWhPerMi } from './efficiency'

describe('deriveEfficiencyWhPerMi', () => {
  it('returns null with no usable samples', () => {
    expect(deriveEfficiencyWhPerMi([])).toBeNull()
    expect(deriveEfficiencyWhPerMi([{ energyKwh: 0, rangeAddedMi: 10 }])).toBeNull()
    expect(deriveEfficiencyWhPerMi([{ energyKwh: 5, rangeAddedMi: 0 }])).toBeNull()
  })

  it('picks the modal factor when a bucket has enough support', () => {
    // 8 sessions at exactly 0.250 kWh/mi → 250 Wh/mi, plus noise.
    const samples = [
      ...Array.from({ length: 8 }, () => ({ energyKwh: 2.5, rangeAddedMi: 10 })),
      { energyKwh: 4, rangeAddedMi: 10 },
      { energyKwh: 1, rangeAddedMi: 10 },
    ]
    expect(deriveEfficiencyWhPerMi(samples)).toBeCloseTo(250, 0)
  })

  it('falls back to the median when no bucket dominates', () => {
    // Factors stay distinct even at precision 1 (0.2 / 0.5 / 0.8), so no mode
    // forms and it returns the median (0.5 → 500 Wh/mi).
    const samples = [
      { energyKwh: 2.0, rangeAddedMi: 10 }, // 200
      { energyKwh: 5.0, rangeAddedMi: 10 }, // 500
      { energyKwh: 8.0, rangeAddedMi: 10 }, // 800
    ]
    expect(deriveEfficiencyWhPerMi(samples)).toBeCloseTo(500, 0)
  })
})
