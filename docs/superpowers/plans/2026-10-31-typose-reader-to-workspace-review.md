# Critical review: reader to workspace plan

Date: 2026-10-31. Plan: [reader to workspace](2026-10-31-typose-reader-to-workspace.md). Baseline: `26a9d69b79cd00e2f4eee6c367a176214ff1303c`.

Status: READY. Both reviewers returned READY after focused verification of the revisions. This is a plan review, not implementation acceptance. No application code, builds, tests, commits, PRs, merges or installations were performed for this task.

## Review method

Two independent reviewers inspected the draft and relevant source/specifications. Both were explicitly instructed: **Open every referenced file; spend half your effort trying to break the design.**

- Product/sequencing: `/root/plan_review_product`.
- Security/memory/contracts: `/root/plan_review_contracts`.

Both returned **FIX-FIRST** on the first draft. Findings below are the actual review results, consolidated where they overlap. Plan line numbers changed during revision; section/PR names below refer to the revised plan.

## Findings and dispositions

| Finding | Consequence | Change made |
|---|---|---|
| P1, both reviewers: LocalRoute-only history excludes ordinary manual opens | `doc.rs:191` captures a route only for Markdown, and capture failure is optional. Manual TXT/CSV and other-platform Reopen could not satisfy the proposed contract. | PR2 now defines host/native-origin `manual` vs `derived` saved locations. Explicit manual Reopen/Back uses existing manual-open policy; derived entries require native tickets, with no pathname fallback after restart. Added the missing acceptance cases and origin preservation through moves/promotion. |
| P2, product: Find blocks the signature workflow without being its dependency | Two substantial search projects would precede any workspace value. | Reader checkpoint after PR3; workspace/CSV/peek checkpoint after PR8; Raw/Rendered find follows in PR9-10. Grid find is explicitly deferred to PR11 rather than advertised as viewport search. |
| P2, product: Grid PR scope understated | New two-axis virtualization, navigation, inference, overrides, mapping and whole-Grid search were bundled as one confidently decent PR. | Native inference/override groundwork moved to PR6. Search deferred. PR7 honestly marked decent to large, with presentation/override boundary review before dispatch and explicit incomplete-contract qualification. |
| P2, technical: Rendered search bound only to document generation misses mutable image text | `images.ts:55,88,164` changes placeholder/refusal/loaded content within one generation, invalidating text ranges and counts. | PR10 adds a surface projection revision, bounded mutable-slot projections, stale result/range invalidation and image transition tests. |
| P2, technical: two-card proof misses the third live surface | Peek can overlay two mounted cards, with a fourth retiring view during promotion. Existing host owns one active document/reservation. | PR8 acceptance explicitly covers left+right+peek+retired, images, same-path variants, low budget and occupied-destination promotion. Ctrl+W closes peek before source. |
| Focused refinement, product: mono line-height change could break Raw geometry | Raw virtualizer/cache assume integer 20px rows (`page-cache.ts:9-10`, `style.css:180`); literal 13x1.55 would diverge. | PR1 keeps Raw at 20px and applies 1.55 to prose code. |
| Focused refinement, product: visual value arrives too late | First installed visual checkpoint was behind multiple native/search PRs. | Install and compare the tested fidelity package immediately after PR1. |
| Documentation reference mismatch | First draft referred to the wrong info-UI PR number. | Revised PR1 points to PR7 CSV info; broader future info fields remain deferred. |

## Scope retained deliberately

- Back/location tickets preserve capability authority without retaining every historical document index.
- Closed-tab history has an explicit separate charge and clear action; close itself succeeds even if undo metadata cannot be paid.
- Directory enumeration/open uses held native authority; no check-path-then-open-path fallback.
- Concurrent views require additive reservations and independently owned native document identities; no UI-only split.
- Frozen CSV spike algorithms/oracles are reusable; uncharged storage, rescan and wire-cap gaps must be replaced in production.
- Grid preview is not M3 acceptance; full M2, broad settings, additional lenses and platform/release qualification remain out of this sequence's checkpoint claim.

## Focused verification

Executed after revision, limited to each reviewer's findings:

- Product/sequencing: **READY**. Verified manual/derived policy and acceptance, Raw row geometry, immediate visual checkpoint, Find moved after the signature checkpoint, and honest CSV/Grid scope. No remaining concrete blocker reported.
- Security/memory/contracts: **READY**. Verified separate saved-location policies, revisioned image-dependent search results, peek-close precedence, and three-live-surface plus retired-view admission/refusal tests. No remaining blocker reported in focused review.

One broad critical review round plus focused verification of the fixes. Neither result claims runtime validation or user approval to begin implementation. PR7's size boundary and the existing qualification debts remain explicit limits, not findings silently declared fixed.
