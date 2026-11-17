# Contributing

See [`README.md`](README.md) to build Typose.

## Checks

Run these from the repository root after building the native addon.

```powershell
npm run lint
npm run check
cargo test --locked --manifest-path core/Cargo.toml
```

Green CI on Windows, Linux and macOS is the merge bar. You do not need to run the full e2e suite locally.

## Flaky tests

Under CI a test that fails and then passes on retry still fails its job. If a job is red only for flaky tests, each seen for the first time on that system, re-run the job and note the test and the run in the PR. If a test is flaky in two runs on one system, or fails its try and its retry in one run, add an entry to [`e2e/quarantine.ts`](e2e/quarantine.ts) that expires within 30 days, or fix the test.

A blank launch on Linux counts against the launch, not against the test it landed on. It is one when the failed try's evidence shows both: in `<pid>-lifecycle.jsonl`, that pid's `did-finish-load` less than 150 ms after its `ready`; and in `failure-N.png`, nothing drawn, a flat fill with no title bar or ☰. Re-run the job, and note the test, the run and both readings in the PR and on [issue #107](https://github.com/zackmeach/typose/issues/107). Whether it took the try, the retry or both, it is not a sighting of that test. The job's other failures count as usual, and the re-run still has to pass.

A macOS job that no hosted runner picked up within 60 minutes, and whose re-run also went unpicked for 60 minutes, may be merged past; note both run ids on the PR. A macOS job that ran and failed never qualifies, however long it waited.

## Tests that need a quiet machine

CI does not fully run these. Run them locally before you tag a release.

- `e2e/perf/`: never run in CI.

  ```powershell
  npm run perf
  ```

- `e2e/rendered-memory.e2e.ts`: CI runs it on Linux only.

  ```powershell
  npm run e2e -- rendered-memory.e2e
  ```

- The heap-rise assertion in `app/core-host/saved-locations.hooks.test.ts`: it is skipped under CI.

  ```powershell
  npm run test:hooks
  ```

- The 250 ms renderer-task and page-timer bounds in `e2e/markdown-extras.e2e.ts`'s math-bombs test: CI on macOS and Windows skips them (`quiet` in `e2e/app.ts`) and runs the rest of the test. CI on Windows also skips its 1 s round-trip bound.

  ```powershell
  npm run e2e -- markdown-extras.e2e -g "math bombs"
  ```

- The 250 ms page-timer bound in `e2e/markdown-extras.e2e.ts`'s dense-highlighting test: CI on macOS skips it and runs the rest of the test. CI on Windows skips its 1 s round-trip bound.

  ```powershell
  npm run e2e -- markdown-extras.e2e -g "dense highlighting"
  ```

- The 50 ms release bounds in `e2e/close.e2e.ts`'s two 10 GiB tests: CI on macOS skips them and runs the rest of each test.

  ```powershell
  npm run e2e -- close.e2e -g "on 10 GiB"
  ```

- The three font-loading checks in `e2e/reader-fidelity.e2e.ts`'s font-delay tests (fonts still loading, and no reader mounted, once the file is indexed; and fonts ready, not fallback, after the 1,000 ms delay): CI on macOS and Windows skips them and runs the rest of each test.

  ```powershell
  npm run e2e -- reader-fidelity.e2e -g "font delay"
  ```

## New e2e tests

A new e2e test must pass on Windows, Linux and macOS. Use `ControlOrMeta+` for shortcuts, not `Control+`. Guard a capability that works on Windows only, such as folder browsing, local links and local images, by platform.

## Fixtures

Fixtures must be synthetic. Never commit a real document or a real transcript.

## Review

These changes get a deeper review than others:

- File-access capabilities.
- The hand-off and external-URL checks.
- The network guard and the CSP.
- IPC.
- The sanitizer.

## Releases

Follow [`docs/release-checklist.md`](docs/release-checklist.md).
