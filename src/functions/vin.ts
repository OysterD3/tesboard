/**
 * Shared input for per-vehicle server functions. The dashboard is single-user
 * but multi-vehicle: the active car is chosen in the UI and threaded down as an
 * optional `vin`. When present, reads are scoped to that vehicle; when absent
 * (e.g. before any car is selected, or a user-level caller) they fall back to
 * all of the user's rows — the `user_id` predicate is always applied separately.
 */
import { z } from 'zod'

/** Validator: `{ vin? }`, and tolerant of being called with no `data` at all. */
export const vinFilter = z.object({ vin: z.string().min(1).optional() }).optional()

export type VinFilter = z.infer<typeof vinFilter>
