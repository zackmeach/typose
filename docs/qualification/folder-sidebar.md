# Folder sidebar demo qualification

This is a bounded Windows demo slice of plan PR4. It does not establish complete huge-directory or cross-platform acceptance. No full gate, package, installed-app, or hosted-CI result is claimed here.

## Authority and lifecycle

`local/folder.rs` captures an explicitly selected local directory through the existing no-reparse native walk. Enumeration uses `GetFileInformationByHandleEx` on that held directory, never `read_dir(displayPath)`. Network/device namespaces are rejected before access. Children retain full native file identity; opening a replaced row refuses until refresh. Unsupported text extensions and reparse/cloud-backed entries are shown as unsupported. Sidebar selection accepts the listed text extensions, including CSV; the existing Markdown-link allowlist stays unchanged.

The host exposes `addRoot`, `listFolder`, `openChild`, and session-checked `removeRoot`. Child/list references contain session, root, and node identities. A root's unchanged entries keep their node identities across refresh. Refresh replaces that directory's cursor; an expired cursor refuses rather than restarting silently. Failed page requests leave existing renderer rows available.

Folder-derived documents and saved locations retain only their selected root scope and route, independently of the browsing registry. Leading `/`, breadcrumb metadata, relative links, source checks, indexing, Reload, Back, and Reopen use that same boundary. Escaping above it refuses. Removing a root releases its loaded browsing records/cursors and cancels unpublished listings/child opens; mounted documents and saved locations keep their original scope. It never upgrades them to manual pathname access.

Manual documents keep manual origin. Active roots bind only at the next fresh open or Reload, choosing the deepest candidate and proving membership against the held file identity. Existing mounted documents are not retrofitted when a root is added. A bound manual document preserves its scope after removal and Reload. Binding during Reload completes before replacing/freezing the previous generation.

## Explicit demo limits and accounting

- At most 16 roots per host, 4096 loaded node records and 64 unfinished directory scans per root. The record count includes retired identities retained so old references cannot retarget replacements. Reaching a cap gives a visible refusal; remove/re-add the root to reclaim browsing state.
- A page returns at most 128 entries and 64 KiB of UTF-8 name bytes, scanning at most 512 records, including hidden/blocked records. An empty page may still have a continuation. There is no recursive scan, pre-count, full-directory sort, or watcher.
- Native scans own a paid 64 KiB aligned buffer plus 4 KiB overhead. Each NAPI listing task reserves 512 KiB through result conversion. Fixed registry capacity and a 1 MiB allowance are paid before allocation; each node additionally reserves `2 * fullPathBytes + 6 * nameBytes + 1024` for its path and sidebar metadata/copies. The selected boundary remains separately charged while any document/route holds it. Empty NAPI root wrappers retain 16 KiB until finalization.
- The host root Map retains a monotonic high-water reservation of `3 * (64 KiB + (2 * 32767 + 2 * 255 + 16 KiB) * peakRoots)`, including full UTF-16 paths/labels. Deleting a Map entry does not claim its capacity was reclaimed. Renderer workspace accounting pays live/retired sidebar and folder breadcrumb metadata; its existing pending-open allowance pays the target overlap while the source remains mounted.

Collapsed unfinished native cursors remain charged until refresh completes/replaces them or the root is removed. A renamed selected root can remain usable through its held handle with its previous display label; rename/missing-root detection is not complete. Locate uses a new explicit capture. Roots are session-only and must be added again after core restart. Ordinary CLI file arrival is unchanged; it does not probe `addRoot` as a classifier.

The allowances above bound owned demo metadata; folder-specific heap churn/GC qualification and maximum-cap stress measurements remain deferred.

## Observed focused checks

Run in Windows PowerShell from the repository root. Real native traversal required execution outside the filesystem sandbox; the initial sandbox attempt failed with access-denied fixture/capture errors.

| Command | Observed result | Ignored evidence |
| --- | --- | --- |
| `cargo test --locked --manifest-path core/Cargo.toml -p typose-core --lib local:: -- --test-threads=1` | 11 passed, 0 failed | `.evidence/audit/folder-native-tests.log` |
| `cargo clippy --locked --manifest-path core/Cargo.toml -p typose-core -p typose-node --all-targets --features typose-node/test-hooks -- -D warnings` | exit 0 | `.evidence/audit/folder-clippy.log` |
| `npm run build:addon` | exit 0 | `.evidence/audit/folder-addon-release.log` |
| `npm run build:addon:hooks` | exit 0 | `.evidence/audit/folder-addon-hooks.log` |
| `npx vitest run app/core-host/folders.test.ts app/core-host/saved-locations.test.ts app/core-host/dispatch.test.ts` | 3 files, 1010 tests passed | `.evidence/audit/folder-host-tests.log` |
| Four-file Vitest parser/host suite | 4 files, 1016 tests passed | `.evidence/audit/folder-rooted-link-tests.log` |
| `npx oxlint --deny-warnings app/core-host/dispatch.ts app/core-host/index.ts app/core-host/folders.test.ts app/shared/protocol.ts` | exit 0 | `.evidence/audit/folder-lint.log` |
| `npm run typecheck` | exit 0 | `.evidence/audit/folder-ui-typecheck.log` |
| `npm run build:hooks --workspace typose` | exit 0 | `.evidence/audit/folder-ui-smoke.log` |
| `npx playwright test e2e/folder-sidebar-demo.e2e.ts -c e2e/playwright.config.ts --output=.evidence/audit/folder-ui-results-fixed` | 2 passed (2.7 s), outside the sandbox against the hooks build | `.evidence/audit/folder-ui-smoke-outside.log` |

The earlier 1,010-test host result remains historical; the updated four-file 1,016-test run is recorded separately. Restricted startup, stale `app/out`, and the empty-tree visibility assertion failures remain preserved in the logs; the final hooks run passed with the rooted link and expanded-directory refresh workflows intact. The initial rooted-link and refresh failures were fixed in the parser and refresh implementation without weakening these assertions.

The native cases exercise real lazy enumeration/paging, stable references and replaced-file refusal, reparse refusal, cancelled listing admission, and derived/manual scope after remove/Reload/Reopen. The NAPI/dispatcher cases cover root node zero, absent public constructor, explicit CSV opening, old-session removal rejection, duplicate pending request rejection, precharge refusal, and removal during an actual async child first page while existing documents/tickets remain usable. Linux/macOS filesystem execution and folder allocation stress were not run.
