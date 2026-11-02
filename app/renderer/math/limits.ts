// One formula's output caps, shared by the KaTeX worker and the main thread, which checks again. No KaTeX import here:
// this module is in the main bundle.

/**
 * A dense 6×6 matrix of fractions is 2,340 elements and 87 KB; a 10×10 one, 6,352. A 14×14 one (12,684) held the main
 * thread long enough to make a page timer 404 ms late, so the cap keeps one formula's insert near 250 ms or under.
 */
export const MATH_MAX_ELEMENTS = 8_192
export const MATH_MAX_BYTES = 1 << 20

/** Elements in KaTeX's escaped output: every `<` followed by a letter opens one. */
export const elementCount = (html: string): number => html.match(/<[a-z]/gi)?.length ?? 0
