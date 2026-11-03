// Plan C4's hostile values, for the core host's and the addon's tables. `undefined` stands for a missing field.
export const HOSTILE: readonly unknown[] = [NaN, Infinity, -Infinity, -1, 0.5, 2 ** 32, 2 ** 32 + 1, 2 ** 53, 1e12, '1', null, undefined]

/** C4's rule: a JS number that is a safe integer within `[min, max]`. Checked before any conversion; never clamped. */
export const isValid = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max

/** A plain object: neither null nor an array. */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
