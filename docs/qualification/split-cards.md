# Split cards demo qualification

This is a focused Windows implementation slice, not a full gate. A reader window groups real card workspaces; focused commands split the current source into a new right card, move a tab right, and close a card. Each card keeps its own selected tab and lens. Split captures the source place into a new native document while leaving the original card mounted. Closing the right card merges its tabs, native document identities, and navigation history into the left without reopening them; the left card retains its selected source, lens, and anchor. Roots and history are session-scoped. The divider supports keyboard resizing with a 320 CSS-pixel minimum per card.

## Observed checks

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `.evidence/audit/split-ui-typecheck.log` |
| Focused hooks split workflow | 1 passed, exit 0; source anchor and native IDs remained stable through split, focused right Reload, divider resize, and merge; two live surface views remained after Reload | `.evidence/audit/split-ui-reload.log` |
| Renderer Vitest suite | 3 files, 29 tests passed | `.evidence/audit/split-renderer-units-fixed.log` |

The earlier renderer-unit attempt is retained at `.evidence/audit/split-renderer-units.log`. Its lens-budget test had a fixture expectation mismatch; the test fixture was corrected and the suite rerun successfully. This was a test fixture correction; the original assertions were retained.

Broader stress, cross-platform behavior, and overlap with image-heavy documents remain unqualified. No package or installed-app result is claimed here.
