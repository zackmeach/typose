/**
 * Blink's layout of the mounted blocks, per UTF-16 unit, with a fifth to spare over the worst script at the 8 MiB
 * ceiling (plan §2.2, by PR 6's method). One scroll end to end, private-byte rise per unit: ASCII 42.37, CJK 91.75,
 * Arabic 101.88, Devanagari 92.92. 128 is a fifth over Arabic (101.88 × 5/4 = 127.35). The HTML's own copies are the
 * separate `2 × htmlBytes` term; beyond those the same runs were 40.37, 85.74, 97.88 and 86.91.
 */
export const RENDERED_PER_UNIT = 128

/** What the lens reserves before it appends anything (plan §2.2): layout per unit, and two copies of the HTML. */
export const renderedCharge = (units: number, htmlBytes: number): number => RENDERED_PER_UNIT * units + 2 * htmlBytes
