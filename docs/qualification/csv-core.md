# Native CSV preview qualification

This slice adds verified native CSV/TSV indexing and bounded Grid data. It is a working preview, not full PR6–8 acceptance, a full gate, or an installed-app qualification.

## Ownership and bounds

CSV retains the existing native `Document`, generation, checked local route, source verification and shared page/index slots. CSV/TSV report `format: 'csv'`; other file classifications retain their existing behavior. No whole-file JavaScript parse or display-path reopen is used.

The native scanner checkpoints parser/source-map state every 1 MiB. It precharges the checkpoint capacity from file size before allocation. Reads are at most 64 KiB; returned field pieces use 4096 bytes plus decoding lookahead and carry original byte spans/maps. Pages independently cap rows and columns at 128, cells at 512, text at 64 Ki UTF-16 units and conservative wire size at 256 KiB, including escaped text and numeric maps. Partial rectangles and field continuations explicitly report progress; far columns do not require returning preceding fields to JavaScript. Raw physical LF lines remain separate from CSV record numbering and multiline field boundaries.

The vendored `csv-core` 0.1.13 changes only `Dfa`/`DfaClasses` cloning to derived field-complete cloning. Its upstream licenses/provenance remain alongside the source. There is no unsafe parser-state copy or new quoting grammar.

Each document owns one published CSV configuration. Header/delimiter changes use a new revision; repeated identical options return the same revision and snapshot without starting another index job. A candidate obtains its index slot and transient reservation before replacing the old configuration. Memory refusal or cancellation before publication preserves the old usable configuration. Reads validate native generation and exact published configuration before work and publication. Reload/close cancel that document's CSV worker; pending native work retains its charged state until it unwinds. `docCharges.total` includes the currently held CSV checkpoint/state reservation; global ledger usage also covers pending/retiring owners and transient work.

Host `CsvRef` adds session/document/generation/revision. The existing surface owner admits configuration changes; exact Surface/View ownership and additive renderer reservations remain in force. CSV local-target support and preview surfaces belong to the later PR8 integration, outside this PR6 evidence.

## Observed focused evidence

| Command/check | Observed result | Ignored evidence |
| --- | --- | --- |
| `cargo test --locked --offline --manifest-path core/Cargo.toml -p typose-core --lib csv -- --test-threads=1` | 6 native scanner/clone/page/source tests passed before the separate PR8 test was added | `.evidence/audit/csv-native-first.log` |
| `npx vitest run app/core-host/csv.test.ts` | 1 file, 6 tests passed | `.evidence/audit/csv-host-focused.log` |
| `cargo check --locked --offline --manifest-path core/Cargo.toml -p typose-node --features test-hooks` | exit 0 | `.evidence/audit/csv-napi-check.log` |
| `npm run build:addon` | release addon compiled | `.evidence/audit/csv-addon-release.log` |
| `npm run build:addon:hooks` | exit 0 | `.evidence/audit/csv-addon-hooks.log` |
| `node .evidence/audit/csv-native-smoke.cjs` | exit 0; real `tasks.csv` configured/indexed, seven source records/six data rows, expected headers and literal values, source/locate agreement, generated camelCase and column `type` verified | `.evidence/audit/csv-native-smoke.log` |
| `node .evidence/audit/csv-native-lifecycle.cjs` | exit 0; charged CSV owner, Memory/cancel preserves old usable revision, stale reads reject, pending close returns jobs/tasks/handles/ledger to baseline | `.evidence/audit/csv-native-lifecycle.log` |
| `cargo clippy --locked --offline --manifest-path core/Cargo.toml -p typose-core -p typose-node --features typose-node/test-hooks -- -D warnings` | exit 0; filesystem sandbox emitted an incremental-cache hardlink fallback warning | `.evidence/audit/csv-clippy.log` |

Native filesystem checks required normal Windows handle access outside the restricted filesystem sandbox. The lifecycle smoke's final jobs/tasks/handles were all zero and ledger usage returned to its 92,293,192-byte shared-pool baseline. Addons preceded two behavior-neutral lint fixes; final delivery rebuild remains an integration step.

The host tests use spy documents to exercise classification/config ownership, reference validation, bounded page/continuation stamping, cancellation, source-preserving failed configuration and same-revision polling. They do not establish actual Grid DOM or packaged behavior. Later parent-owned Grid/preview/package results are separate integration evidence.

## Preview limits

First-1000-row type inference, categorical pills, sampled widths and paged problem metadata are deferred. Column metadata currently supplies bounded names, generic text type and bounded header-based widths, with `metadataDone: false`. Header/delimiter overrides are reversible; encoding overrides and their generation-changing handoff are deferred. UTF-16 CSV/TSV stays Raw-only with an explicit Grid refusal.

The checks above cover the original parser and preview. [Grid interactions](csv-grid.md) describes the later native sort order, whole-file cell search and range copy. Broader throughput, allocation/GC and cross-platform qualification remain open.
