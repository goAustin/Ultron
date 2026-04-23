/**
 * Shared numeric constants for `ModelEntry` capability fields.
 *
 * Centralized so "64K output" lives in one place, not restated across every
 * adapter catalog. Consumers: the three adapter catalog files. Pure
 * constants — zero runtime logic.
 */

// Context windows (tokens)
export const CONTEXT_1M   = 1_000_000
export const CONTEXT_400K =   400_000
export const CONTEXT_256K =   256_000
export const CONTEXT_200K =   200_000

// Output caps (tokens)
export const OUTPUT_128K = 128_000
export const OUTPUT_64K  =  64_000
export const OUTPUT_16K  =  16_384
