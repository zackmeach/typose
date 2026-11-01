# Saved locations: PR2a native/host boundary

This backend slice supplies `captureLocation`, `openSaved` and `releaseSaved`. It does not add Back, closed-tab history or renderer persistence. PR2b must supply the charged history transaction and visible Back control. This does not complete M2.

## Authority and ownership

Capture accepts only an owned document/generation. Native `localOnly` determines origin: manual Markdown remains manual even when its optional local route exists; manual TXT/CSV, optional-route-failure Markdown and platform fallback do not require that route. Manual capture returns the native-owned path for existing manual-open policy.

Derived capture retains a charged `LocalRoute` clone. It retains no Document, Raw, index, first page, Markdown build or image state. Derived TXT and frozen owned generations can be captured without a Markdown build or a fresh filesystem read. Reopen is non-consuming and constructs a new generation-1 document/index from current verified bytes through the saved route. Missing/binary/retargeted targets refuse without converting the ticket to manual pathname access.

The host owns opaque UUID tickets scoped to its session. Invalid, released or old-session tickets cannot reconstruct authority; UUID collisions refuse without overwriting the existing owner. Tickets are session-only and must not be written into durable recents/session storage.

Candidate first-page reads remain registered through synchronous publication. Cancellation/setup failures, source invalidation and ticket release dispose unpublished targets and their jobs without closing borrowed sources. Pending candidates survive ordinary view deactivation, while explicit request/source invalidation still prevents publication. Slower valid manual opens can still become inactive tabs when a newer view holder wins. A partially started index burns its document identity so late progress cannot address the next document.

## Accounting and cleanup

Three retained costs have different lifetimes:

- The route's native path/root reservation releases on `releaseSaved` or native `SavedRoute.release`. The last route releases its persistent root handle. Existing document close still releases its independent document/index owners.
- Each napi saved-route wrapper reserves **16 KiB** until actual native Drop, including after logical release. This pays its residual native wrapper and associated UUID/entry/wrapper garbage before finalization. Keeping an empty wrapper reachable therefore keeps its reservation; it is not reported as freed native storage.
- The host precharges **3 × (64 KiB + 16 KiB × peak live ticket entries)** through the existing aggregate native renderer reservation. It keeps that Map backing/retired-capacity high water until host exit, including after the logical ticket count becomes zero. View or workspace release does not erase this separate share. There is no silent ticket eviction or count cap.

`debugStats.saved` distinguishes logical tickets, active route bytes, all residual wrapper bytes through Drop, host high-water bytes/entries and pending candidates. A released ticket is not proof of an all-ledger zero. Window/core-host destruction releases that host's allocation; old-session cleanup cannot release a replacement host's share.

## Focused Windows evidence

These results cover the uncommitted PR2a implementation based on `5302e302e5b1497e75cc8693db7ac3d9c67f0871`. They are **not** a final-head full gate or packaged acceptance. Initial free space was 46,123,876,352 bytes; checks remained above the required 20 GiB.

| Command | Observed result |
| --- | --- |
| `npm run build:addon` | Rust release compilation succeeded; sandboxed NAPI output transaction failed. The parent reran the same command outside the sandbox and NAPI recovered its own journal, exit 0. |
| `npm run build:addon:hooks` outside the sandbox | Exit 0. |
| `npx vitest run app/core-host/dispatch.test.ts app/core-host/saved-locations.test.ts app/core-host/saved-native.test.ts` outside the sandbox | 3 files, 1,015 tests passed. |
| `npx vitest run --mode test-hooks app/core-host/saved-locations.hooks.test.ts --reporter=verbose --silent=false --disableConsoleIntercept` outside the sandbox | 1 file, 5 tests passed, including real-addon cancellation and the measurements below. |
| Earlier `npx vitest run --mode test-hooks app/core-host/saved-locations.hooks.test.ts app/core-host/napi.hooks.test.ts` outside the sandbox | 2 files, 11 tests passed before the two additional focused hook cases. This is not a claim of a later combined rerun. |
| `cargo test --manifest-path core/Cargo.toml --locked -p typose-core saved_routes_keep_no_document_and_never_follow_a_retargeted_pipe_ancestor` outside the sandbox | Selected native unit test passed; this command also ran the harness-free ledger binary, which ended `ok`: 7,330,906 allocations checked, 0 skipped, with allocation negative controls detecting violations. Exit 0. |
| `npm run typecheck` | Exit 0. |
| `npx oxlint --deny-warnings app/core-host app/shared/protocol.ts e2e/packaged.e2e.ts` | Exit 0. |
| `cargo fmt --all --manifest-path core/Cargo.toml` and `git diff --check` | Exit 0. |

The tests cover manual origin variants, direct-construction refusal, derived TXT/frozen capture, fresh replacement bytes, binary/missing/junction/named-pipe refusal, idempotent release, source-close retention, stale/forged tickets, UUID collisions, budget refusals, setup/index/handoff failures, duplicate pending request IDs, and concurrent inactive-tab publication. Real-addon cancellation proves the unpublished candidate returns jobs/tasks/handles/ledger to its pre-open saved/source baseline, leaves source reads usable and permits a later ticket reopen.

### Host memory measurements

Two independent fresh dispatchers were warmed at peak one, then baselined after GC. The peak-one run never received the peak-256 table allowance. Heap/external readings were bracketed by matching native wrapper counts/bytes and ledger values; unstable samples were retried. Each run performed 4,000 capture/release churn operations without forced GC during churn.

| Peak entries | Stable samples | Maximum observed heap + external rise | Maximum contemporaneous host + residual allowance | Post-GC rise | Retained host table share |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 252 | 4,965,912 B | 65,798,144 B | 102,246 B | 245,760 B |
| 256 | 267 | 4,882,416 B | 82,509,824 B | 62,189 B | 12,779,520 B |

Every stable sample stayed within its contemporaneous allowance; minimum observed margins were 253,096 B and 258,152 B respectively. These maxima need not occur in the same sample. Before forced GC, the runs retained 4,001 wrappers/65,552,384 B and 4,256 wrappers/69,730,304 B respectively; after GC both reported zero residual wrappers/bytes. Route handles release immediately, independently of wrapper finalization.

Both runs passed the **residual-wrapper** negative control: keeping two logically released wrappers reachable under a lower native budget made the next capture fail with `Memory`. That is distinct from the Map's high-water allowance. Host grant-before-capture refusal and collision preservation are covered by dispatcher tests. The coefficients are supported by these bounded Windows host measurements, not a universal V8/Chromium/process-memory guarantee or arbitrary unbounded workload proof.

## Remaining seam and limits

PR2b must precharge persistent manual/derived history metadata and the incoming target first-page payload while the source remains mounted, including delayed replies and retired renderer copies. Existing native page pools pay native/host page work and host copies; they do not establish the renderer's pending-target allowance. No permanent per-document first-page tax was added here. Restart must recharge retained renderer history before enabling workspace work, while old derived tickets require explicit manual reselection.

Only Windows was exercised. Local derived routes remain refused on unsupported platforms; manual platform fallback retains its existing policy. The packaged hook-absence assertions now include `savedStats`/`savedRouteBytes`, but package/E2E/install/full final-head gates were not run in this implementation pass. Those remain the parent's post-review gate. Detailed observed outputs and NAPI recovery evidence remain in ignored `.evidence/audit/back-focused-results.md` and `.evidence/audit/back-napi-recovery-build.log`.
