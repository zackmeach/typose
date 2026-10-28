import type { MdBuild } from '../../shared/protocol'

/**
 * Historical scroll allowance per UTF-16 unit, with a fifth to spare over the worst script at the 8 MiB ceiling
 * (plan §2.2, by PR 6's method). One scroll end to end, private-byte rise per unit: ASCII 42.37, CJK 91.75,
 * Arabic 101.88, Devanagari 92.92. 128 is a fifth over Arabic (101.88 × 5/4 = 127.35). The HTML's own copies are the
 * separate `2 × htmlBytes` term; beyond those the same runs were 40.37, 85.74, 97.88 and 86.91. These post-mount
 * measurements alone do not cover initial DOM allocation; the node and fixed allowances below cover that component.
 */
export const RENDERED_PER_UNIT = 128

// Windows calibration (plan §6): eight shapes, 1/200/2,000 source repetitions, accessibility off/on; warmed empty-card baseline
// before open, peak through mount and end scroll. After text/HTML, worst 200→2,000 residual slope: 13,073.536 B/node;
// ×1.25, rounded up to 64 B = 16,384. Maximum remaining fixed residual: 4,241,712 B; ×1.25, rounded up to MiB = 6 MiB.
export const RENDERED_PER_NODE = 16384
export const RENDERED_FIXED = 6 << 20

/** The generation's Rendered share, before any block mounts: text, generated labels, DOM nodes and HTML copies. */
export const renderedCharge = (build: Pick<MdBuild, 'units' | 'htmlBytes' | 'nodes' | 'noteUnits'>): number =>
  RENDERED_FIXED + RENDERED_PER_UNIT * (build.units + build.noteUnits) + RENDERED_PER_NODE * build.nodes + 2 * build.htmlBytes
