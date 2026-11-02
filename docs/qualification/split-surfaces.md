# Split surface backend qualification

This note records the host/protocol ownership slice on base `60ff818`. It does not claim packaged split-card behavior, installed-app validation, a full gate, or broader memory/platform qualification.

## Ownership contract

`createSurface` returns a session-bound `SurfaceRef`. Every explicit card supplies it for open, folder child open, saved/local open, activation, Reload and document close. Each native document has exactly one surface owner. Same-path documents opened in separate cards get independent document identities; they do not share a destructive controller owner.

Every published activation receives an exact `ViewRef`, including a fresh lease ID as well as surface/document/generation. `reserve` and `deactivate` accept that lease. An old A→B→A lease cannot resize or dispose the later activation. Published source views remain active and paid until their own detach; activating another surface neither trims their caches nor cancels their reads. Source checks, generation checks, native folder scope, saved routes and index ownership retain their existing document contracts.

Pending first pages retain their own additive share until they finish or unwind, including after surface removal. A cancelled/unpublished candidate closes only its target. A superseded fresh open may still register an inactive background document; it returns no active lease and `reserved: 0`. Superseded retained activation is cancelled within its own surface. Retained Reload can finish current metadata/indexing in the background without restoring a disposed view.

`transferDoc` changes ownership of a quiescent document after the source view/controller is detached. It checks the source owner and generation, refuses live views or unfinished operations, and preserves the native document/index identity. Saved-location tickets remain window/session resources; moving tab/history metadata does not consume or reconstruct authority.

`releaseSurface` invalidates the surface first, cancels its operations and closes only its remaining owned documents. Renderer code must acknowledge the window workspace retirement precharge before dropping the source share. The host checks that the declared retirement covers remaining live leases and is paid by the workspace share. Removed surfaces do not accumulate permanently retained full live budgets. Late old-surface cleanup cannot recreate a surface or close a moved document.

## Accounting and compatibility

The native renderer reservation is the sum of all live leases, all pending target shares, the window workspace/retirement share, saved/root host metadata and surface-table metadata. Each view's own allowance includes its renderer controller's retained-tree/image allowance. `Opened.reserved` reports only that response's active lease, never the window total. Memory refusal leaves prior live leases unchanged.

Before table allocation/growth, the host pays a monotonic capacity allowance of `3 * (64 KiB + 4096 * peakSurfaces + 1024 * (peakViews + peakPending))`. The default compatibility surface is included. Deleting entries does not claim retained Map capacity was reclaimed. Surface and view IDs are checked against the protocol's safe integer range before allocation; IDs are never reused within a host session. This slice has not measured surface-specific heap churn/GC or maximum-card stress.

Omitting `surface` selects the isolated compatibility owner zero. It uses the same additive state/accounting engine. Legacy document/generation reserve and deactivate calls operate only on owner-zero documents and cannot affect explicit card owners. Explicit cards require exact leases. Existing single-card tests now detach prior views where their fixture models a single mounted card and assert additive source/target charges plus the retained table allowance.

The shared native page/index pool remains process-wide. This slice changes no Rust, NAPI, filesystem authority or index implementation.

## Observed focused checks

| Command | Observed result | Ignored evidence |
| --- | --- | --- |
| `npx vitest run app/core-host/surfaces.test.ts app/core-host/dispatch.test.ts app/core-host/saved-locations.test.ts app/core-host/folders.test.ts app/core-host/local-target.test.ts` | 5 files, 1023 tests passed | `.evidence/audit/split-host-focused.log` |
| `npx tsc --noEmit -p app/core-host` | exit 0 | `.evidence/audit/split-host-typecheck.log` |
| `npx oxlint --deny-warnings app/core-host app/shared/protocol.ts` | exit 0 | `.evidence/audit/split-host-lint.log` |

The surface tests use spy documents to exercise independent owners, additive reservations, stale lease rejection, pending close/unwind, source preservation on refusal, transfer without reopen/index restart, retirement precharge and repeated surface release/reuse. The existing folder tests exercise actual Windows NAPI documents/capabilities through the changed dispatcher and required execution outside the filesystem sandbox. Actual simultaneous Raw/Rendered DOMs, card resize/focus, loaded images, installed behavior and broader allocation/platform proof belong to subsequent UI/E2E qualification; they are not inferred from these host tests.
