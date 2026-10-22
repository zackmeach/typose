# Typose Phase 0 · Base harness + Spike A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a throwaway Electron + Rust harness. Then measure Spike A's risks against numeric gates and report the results:
- cold start;
- multi-GB indexing and IPC;
- memory;
- logical scrolling deep inside huge files;
- the Windows title bar;
- the NetLog assertion.

**Architecture:**
- **Rust:** a `spike-core` crate holds the file-backed byte store (positional reads, 1MiB chunks hashed with xxh3, a small cache) and a line index with byte-bounded checkpoints. A thin `spike-node` napi-rs addon exposes it.
- **Electron:** an app built with electron-vite. Main forks a `utilityProcess` "core host" that loads the addon, and hands the renderer a `MessageChannelMain` port, so viewport traffic never touches main.
- **Renderer:** vanilla TypeScript with a framework-free virtualizer. It scrolls natively below a 16M px spacer and logically above it.

**Tech Stack:**
- **Electron side:** Electron 44.9.2, electron-vite 6.0.0, Vite 8.3.4, TypeScript 7.0.2, Vitest 5.0.5, Playwright 1.64.1, electron-builder 26.15.3.
- **Rust side:** Rust 1.96 (edition 2024), napi 3 / napi-derive 3 / napi-build 2 with @napi-rs/cli 3.10.8, memchr 2.8, xxhash-rust 0.8 (xxh3), serde_json 1, proptest 1.12. rayon 1.12 is used only if Task 12 runs.

**Spec:** `docs/superpowers/specs/2026-10-20-typose-tech-design.md` (Draft 3): §3.1–3.5, §5.3, §7.1, §7.3, §9, §10, §13.1 Spike A. The design brief, revision 5, is `docs/superpowers/specs/2026-10-20-typose-design-brief.md`.

**Phase 0 plan set:**
1. **This plan:** base harness + Spike A.
2. **Spike C:** `2026-10-20-typose-phase0-spike-c.md`, branched from `spike/a`.
3. **Spike B:** `2026-10-20-typose-phase0-spike-b.md`, branched from `spike/a`.

The Phase 0 checkpoint follows them and updates the spec. Only then is the M1 plan written.

**Validated:** every code block in Tasks 1–10 was compiled and run in a scratch copy on Zack's PC:
- all Rust tests and the napi build;
- every vitest and node:test file;
- all three e2e tests;
- the whole perf runner, against 1 GiB and 1.2 GiB stand-in fixtures;
- `npm run pack`, plus a launch of the packaged build.

Task 12's code compiled and its test ran.

An independent reviewer then rebuilt the plan from its text alone in a fresh sandbox, ran every step, and reverted each fix to check that something catches it. It did this three times. Its findings are folded in. The ones that changed code:
- a leaked `TYPOSE_OPEN` that made first-screen samples negative;
- the 256 KiB page cap being exceeded;
- Space scrolling proportionally in logical mode;
- an unpinned network guard;
- an input-latency probe with almost no samples;
- "indexing done at first screen" read late enough under load to count a scan that finished after the paint;
- a zoom persisted in the shared app profile that skewed every measurement;
- the parallel indexer holding back the first progress event by a whole batch;
- the scrollbar dropping a user drag that arrived in the same frame as a progress event;
- the first fix for that, which read the old scroll position under the new total, so an idle view jumped on progress events during indexing. That jump would have read as a false fail of the Mac trackpad gate.

The scratch run and the review found these defects in earlier drafts, all fixed below:
1. The `typose://` handler was blocked by the app's own network guard.
2. Chromium quantizes large `scrollTop` values.
3. WPAD sent DNS lookups at startup.
4. First-screen timing was taken while the window was still starting up.
5. A leftover `TYPOSE_OPEN` in the shell corrupted every perf launch.

The progress-throttle exemption for the first screen (Task 7) is a precaution. No measurement showed the throttle delaying a first screen.

**Amended for Z37** (spec §0.3, §10.2, §13.1): Raw's first screen is the first bounded piece, visible and usable, with continuation available while scanning proceeds. Full-line scan completion is measured separately. So:
- Task 6 adds `pages::piece`, the continuation, and a test pinning that the line the scan is inside already counts as a line;
- Task 7 exposes it as `Doc.piece` and the RPC `piece`;
- Task 9's lens marks the first screen at its first page;
- Task 10 times the full-line scan apart, on `huge-first.jsonl` and on a one-line 1 GiB fixture that Task 2 adds;
- Task 11's counts, Mac fixture command and REPORT-A rows follow.

Tasks 1–10 were rebuilt from the amended text in a fresh directory, and every changed step was re-run.

## Global Constraints

- **Throwaway code.** Everything lives under `spikes/` on `spike/*` branches and is **never merged to `main`** (spec §13.1). The spike's output is its report and numbers, not the code.
- **Branches:** `spike/base` is cut from `main`; `spike/a` is cut from `spike/base`. Commit on the spike branch after each task.
- **Staging:** stage explicit paths only and never use `git add -A`. Never stage research files: `astra-research.md`, `fable-research.md`, `docs/research/`.
- **Rule 8 (standing procedure):** whoever writes a file reads the final on-disk version in full before calling the task done.
- **Gate thresholds:**
  - On Zack's PC they are **half** the budget, unless marked **Mac**, which uses the full budget (spec Z29, §10.2).
  - The PC is an i7-12700K with 32GB, an RTX 3070 Ti, a 980 PRO NVMe, and Windows 11 26200 with Defender on.
  - Warm means n=30, judged on p95. Cold means n=5 after OS restarts, judged on the worst run.
- **File access:** positional reads only. **No memory-mapping on any OS** (spec §3.3). On Windows, `std::fs::File::open` already uses `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`.
- **Fixed sizes:**
  - Chunk: `CHUNK = 1 MiB`.
  - Checkpoints: every **1,024 lines or 1 MiB, whichever comes first** (spec §3.5).
  - Rendering unit: ≤ **64 KiB** of text per item (`MAX_PIECE = 65_536`).
  - Page: ≤ **256 KiB** (`MAX_PAGE = 262_144`) (spec §3.4).
- **Scrolling:** native while the content is ≤ **16,000,000 px** (`SPACER_CAP`). Above that, logical scrolling: wheel, trackpad and keys move 1:1, and the scrollbar does coarse positioning only (spec §5.3).
- **Transport:**
  - At most **2 outstanding viewport requests per lens**.
  - Requests coalesced to **one per animation frame**.
  - Progress events at **≤ 10 Hz**, except the first event, the done event, and every event while fewer than 256 lines are known. The first screen must not wait on the throttle.
- **Network:**
  - The renderer may only load `typose:`, `data:` and `blob:` (plus `devtools:` in unpackaged builds).
  - Proxy resolution is off (`--no-proxy-server`).
  - The NetLog assertion fails on any other-scheme URL request, any DNS resolution, or any socket connect (spec §7.3).
- **Commands:** they work in PowerShell and in Git Bash unless a step gives both forms. Run them from the directory each step names.
- **Fixtures** go in `spikes/.fixtures/` (gitignored). The fixtures need about 13 GB free on the NVMe (10 GiB, 1 GiB, the 1 GiB one-line and huge-first).

---

## File Structure

```
spikes/
  .gitignore
  core/                         Cargo workspace (Rust)
    Cargo.toml
    spike-core/                 library: byte store, line index, pages
      Cargo.toml
      src/lib.rs                version(), module wiring
      src/store.rs              ByteStore, ChunkHashes, read_at, StoreError
      src/index.rs              LineIndex, Checkpoint, IndexConfig, build(), locate_line()
      src/pages.rs              LinePiece, RowSummary, lines(), piece(), rows()
    spike-node/                 napi-rs addon (thin; no logic)
      Cargo.toml, build.rs, package.json
      src/lib.rs                coreVersion(), class Doc
    fixtures-gen/               fixture generator
      Cargo.toml
      src/lib.rs                jsonl(), huge_record()
      src/main.rs               CLI
  app/                          Electron app (electron-vite default layout)
    package.json, electron.vite.config.ts, playwright.config.ts
    src/main/index.ts           window, typose://, network guard, core-host fork, port hand-off
    src/main/core-host.ts       utilityProcess entry: RPC over MessagePort → spike-node
    src/main/env.d.ts           `?modulePath` import types
    src/preload/index.ts        forwards the core port to the main world
    src/renderer/index.html
    src/renderer/src/core.ts          RPC client over the port
    src/renderer/src/scrollmath.ts    pure scroll math + ScrollState (unit-tested)
    src/renderer/src/virtual-list.ts  DOM virtualizer on ScrollState
    src/renderer/src/lens-view.ts     Raw/Rows lenses: paging, coalescing, painting
    src/renderer/src/perf.ts          percentile, frameStats, PerfLog (unit-tested)
    src/renderer/src/main.ts          boot, open(), window.__spike, F9 frame sampler
    src/renderer/src/style.css
    e2e/roundtrip.e2e.ts, e2e/open.e2e.ts, e2e/shell.e2e.ts
    perf/spike-a.e2e.ts         Playwright perf runner: every in-app Spike A gate
    perf/shell-visible.mjs      shell-visible timing without Playwright in the loop
  tools/
    netlog-assert.mjs           NetLog assertion (spec §7.3)
    netlog-assert.test.mjs      node:test
  results/                      committed JSON results + REPORT-A.md
```

---

## Task 1: Base harness — the renderer reaches the Rust addon through the core host

**Files:**
- Create: `spikes/.gitignore`, `spikes/core/Cargo.toml`, `spikes/core/spike-core/Cargo.toml`, `spikes/core/spike-core/src/lib.rs`
- Create: `spikes/core/spike-node/Cargo.toml`, `spikes/core/spike-node/build.rs`, `spikes/core/spike-node/package.json`, `spikes/core/spike-node/src/lib.rs`
- Create: `spikes/app/package.json`, `spikes/app/electron.vite.config.ts`, `spikes/app/playwright.config.ts`
- Create: `spikes/app/src/main/index.ts`, `spikes/app/src/main/core-host.ts`, `spikes/app/src/main/env.d.ts`, `spikes/app/src/preload/index.ts`
- Create: `spikes/app/src/renderer/index.html`, `spikes/app/src/renderer/src/core.ts`, `spikes/app/src/renderer/src/main.ts`
- Test: `spikes/app/e2e/roundtrip.e2e.ts`

**Interfaces:**
- **Produces:**
  - Rust: `spike_core::version() -> &'static str`.
  - napi: `coreVersion(): string`.
  - Renderer: `connectCore(): Promise<Core>`, where
    ```ts
    interface Core {
      call<T>(method: string, params?: unknown): Promise<T>
      onEvent(cb: (e: CoreEvent) => void): void
    }
    ```
  - Wire format:
    - request `{ id, method, params }`;
    - response `{ id, result } | { id, error }`;
    - event `{ event: string, ...fields }`.
  - `window.__spike = { core }`, which tests use to reach the core.

- [ ] **Step 1: Create the branch and ignore rules**

Run (repo root):
```bash
git switch -c spike/base main
```
Create `spikes/.gitignore`:
```gitignore
node_modules/
app/out/
app/dist/
app/test-results/
core/target/
core/spike-node/*.node
core/spike-node/index.js
core/spike-node/index.d.ts
.fixtures/
*.netlog.json
```

- [ ] **Step 2: Write the Rust workspace and the trivial core with its test**

`spikes/core/Cargo.toml` (only `spike-core` for now; Step 4 adds `spike-node`):
```toml
[workspace]
resolver = "2"
members = ["spike-core"]

[profile.release]
lto = "thin"
codegen-units = 1
```
`spikes/core/spike-core/Cargo.toml`:
```toml
[package]
name = "spike-core"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
```
`spikes/core/spike-core/src/lib.rs`:
```rust
//! Throwaway spike core. See docs/superpowers/specs/2026-10-20-typose-tech-design.md §13.1.

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_the_crate_version() {
        assert_eq!(super::version(), "0.0.0");
    }
}
```

- [ ] **Step 3: Run the Rust test**

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `test tests::version_is_the_crate_version ... ok`

- [ ] **Step 4: Write and build the napi addon**

In `spikes/core/Cargo.toml`, change the members line to:
```toml
members = ["spike-core", "spike-node"]
```
`spikes/core/spike-node/Cargo.toml`:
```toml
[package]
name = "spike-node"
version = "0.0.0"
edition = "2024"
publish = false

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = "3"
napi-derive = "3"
spike-core = { path = "../spike-core" }

[build-dependencies]
napi-build = "2"
```
`spikes/core/spike-node/build.rs`:
```rust
fn main() {
    napi_build::setup();
}
```
`spikes/core/spike-node/src/lib.rs`:
```rust
use napi_derive::napi;

#[napi]
pub fn core_version() -> String {
    spike_core::version().to_string()
}
```
`spikes/core/spike-node/package.json`:
```json
{
  "name": "spike-node",
  "version": "0.0.0",
  "private": true,
  "main": "index.js",
  "types": "index.d.ts",
  "napi": { "binaryName": "spike-node" },
  "scripts": {
    "build": "napi build --platform --release",
    "build:debug": "napi build --platform"
  },
  "devDependencies": { "@napi-rs/cli": "3.10.8" }
}
```
Run (`spikes/core/spike-node`): `npm install`, then `npm run build`.
Expected:
- `spike-node.win32-x64-msvc.node`, `index.js` and `index.d.ts` appear;
- `index.d.ts` contains `export declare function coreVersion(): string`.

- [ ] **Step 5: Write the Electron app skeleton**

`spikes/app/package.json`:
```json
{
  "name": "spike-app",
  "version": "0.0.0",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "build": "electron-vite build",
    "test": "vitest run",
    "e2e": "playwright test --project=e2e",
    "perf:a": "playwright test --project=perf spike-a",
    "pack": "electron-builder --dir"
  },
  "dependencies": { "spike-node": "file:../core/spike-node" },
  "devDependencies": {
    "@playwright/test": "1.64.1",
    "electron": "44.9.2",
    "electron-builder": "26.15.3",
    "electron-vite": "6.0.0",
    "typescript": "7.0.2",
    "vite": "8.3.4",
    "vitest": "5.0.5"
  },
  "build": {
    "appId": "dev.typose.spike",
    "files": ["out/**"],
    "asarUnpack": ["**/*.node"]
  }
}
```
`spikes/app/electron.vite.config.ts`:
```ts
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {}
})
```
`spikes/app/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 30 * 60_000,
  workers: 1,
  projects: [
    { name: 'e2e', testDir: 'e2e', testMatch: '*.e2e.ts' },
    { name: 'perf', testDir: 'perf', testMatch: '*.e2e.ts' }
  ]
})
```
`spikes/app/src/main/env.d.ts`:
```ts
/// <reference types="electron-vite/node" />
```
`spikes/app/src/main/core-host.ts`:
```ts
import type { MessagePortMain } from 'electron'
import { coreVersion } from 'spike-node'

type Handler = (params: never) => unknown

function serve(port: MessagePortMain): void {
  const handlers: Record<string, Handler> = {
    version: () => coreVersion()
  }
  port.on('message', ({ data }) => {
    const { id, method, params } = data as { id: number; method: string; params: never }
    try {
      const handler = handlers[method]
      if (!handler) throw new Error(`unknown method ${method}`)
      port.postMessage({ id, result: handler(params) })
    } catch (err) {
      port.postMessage({ id, error: String(err) })
    }
  })
  port.start()
}

process.parentPort.once('message', (e) => serve(e.ports[0]))
```
`spikes/app/src/main/index.ts`:
```ts
import { app, BrowserWindow, MessageChannelMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import coreHostPath from './core-host?modulePath'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const core = utilityProcess.fork(coreHostPath, [], { serviceName: 'typose-core' })
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage({ type: 'port' }, [port1])
  win.webContents.once('did-finish-load', () => win.webContents.postMessage('core-port', null, [port2]))
  win.once('ready-to-show', () => win.show())
  void win.loadFile(join(__dirname, '../renderer/index.html'))
}

void app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
```
`spikes/app/src/preload/index.ts`:
```ts
import { ipcRenderer } from 'electron'

// The sandboxed renderer can't receive a MessagePort over contextBridge; forward it to the main world.
ipcRenderer.on('core-port', (event) => {
  window.postMessage('core-port', '*', event.ports)
})
```
`spikes/app/src/renderer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'" />
    <title>Typose spike</title>
  </head>
  <body>
    <div id="status">connecting…</div>
    <div id="card"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
```
`spikes/app/src/renderer/src/core.ts`:
```ts
export interface CoreEvent {
  event: string
  [field: string]: unknown
}

export interface Core {
  call<T>(method: string, params?: unknown): Promise<T>
  onEvent(cb: (e: CoreEvent) => void): void
}

export function connectCore(): Promise<Core> {
  return new Promise((resolve) => {
    window.addEventListener('message', function onPort(e: MessageEvent) {
      if (e.data !== 'core-port') return
      window.removeEventListener('message', onPort)
      const port = e.ports[0]
      let nextId = 1
      const pending = new Map<number, { ok: (v: unknown) => void; fail: (err: Error) => void }>()
      const listeners: ((e: CoreEvent) => void)[] = []
      port.onmessage = (m: MessageEvent) => {
        const data = m.data as { id?: number; result?: unknown; error?: string } & CoreEvent
        if (data.id === undefined) {
          for (const l of listeners) l(data)
          return
        }
        const p = pending.get(data.id)
        pending.delete(data.id)
        if (data.error !== undefined) p?.fail(new Error(data.error))
        else p?.ok(data.result)
      }
      resolve({
        call: <T>(method: string, params?: unknown) =>
          new Promise<T>((ok, fail) => {
            const id = nextId++
            pending.set(id, { ok: ok as (v: unknown) => void, fail })
            port.postMessage({ id, method, params })
          }),
        onEvent: (cb) => {
          listeners.push(cb)
        }
      })
    })
  })
}
```
`spikes/app/src/renderer/src/main.ts`:
```ts
import { connectCore } from './core'

const core = await connectCore()
;(window as any).__spike = { core }
document.getElementById('status')!.textContent = `core ${await core.call<string>('version')}`
```

- [ ] **Step 6: Write the failing round-trip test**

`spikes/app/e2e/roundtrip.e2e.ts`:
```ts
import { _electron as electron, expect, test } from '@playwright/test'

test('the renderer reaches the Rust core through the utility process', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await expect(win.locator('#status')).toHaveText('core 0.0.0')
  await app.close()
})
```
Run (`spikes/app`): `npm install`, then `npm run e2e`.
Expected: FAIL after Playwright's 180 s launch timeout: `TimeoutError: electron.launch: Timeout 180000ms exceeded.` `out/main/index.js` doesn't exist yet, so Electron shows its "no app" dialog instead of a window. Close the dialog.

- [ ] **Step 7: Build and run the test until it passes**

Run (`spikes/app`): `npm run build`, then `npm run e2e`.
Expected: `1 passed`.

- [ ] **Step 8: Read your own work (rule 8), then commit**

Re-read every file created in this task. Then:
```bash
git add spikes/.gitignore spikes/core/Cargo.toml spikes/core/Cargo.lock spikes/core/spike-core spikes/core/spike-node/Cargo.toml spikes/core/spike-node/build.rs spikes/core/spike-node/package.json spikes/core/spike-node/package-lock.json spikes/core/spike-node/src spikes/app/package.json spikes/app/package-lock.json spikes/app/electron.vite.config.ts spikes/app/playwright.config.ts spikes/app/src spikes/app/e2e
git commit -m "spike(base): renderer reaches Rust core via utilityProcess MessagePort"
```

---

## Task 2: Fixture generator

**Files:**
- Modify: `spikes/core/Cargo.toml` (add the `fixtures-gen` member)
- Create: `spikes/core/fixtures-gen/Cargo.toml`, `spikes/core/fixtures-gen/src/lib.rs`, `spikes/core/fixtures-gen/src/main.rs`

**Interfaces:**
- **Produces:**
  - `fixtures_gen::jsonl<W: Write>(w: &mut W, target_bytes: u64, line_len: usize) -> io::Result<u64>`. It writes JSONL lines of exactly `line_len` bytes each (newline included) until at least `target_bytes`, and returns the line count. Line *n* contains `"msg":"line <n, 10 digits> "`.
  - `fixtures_gen::huge_record<W: Write>(w: &mut W, payload_bytes: u64) -> io::Result<()>`. It writes one JSON record whose `msg` string is `payload_bytes` long, followed by a newline.
  - CLI: `fixtures-gen <jsonl|jsonl-huge-first> --out <path> [--bytes N] [--line N] [--first N]`. It creates the output's parent directory.

- [ ] **Step 1: Add the crate and write failing tests**

In `spikes/core/Cargo.toml`, change the members line to:
```toml
members = ["spike-core", "spike-node", "fixtures-gen"]
```
`spikes/core/fixtures-gen/Cargo.toml`:
```toml
[package]
name = "fixtures-gen"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
```
`spikes/core/fixtures-gen/src/lib.rs`:
```rust
use std::io::{self, Write};

const TYPES: [&str; 4] = ["plan", "tool", "model", "eval"];

/// JSONL lines of exactly `line_len` bytes (newline included) until `target_bytes` is reached.
pub fn jsonl<W: Write>(w: &mut W, target_bytes: u64, line_len: usize) -> io::Result<u64> {
    todo!()
}

/// One record whose `msg` is `payload_bytes` of 'a', then a newline.
pub fn huge_record<W: Write>(w: &mut W, payload_bytes: u64) -> io::Result<()> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonl_lines_are_exact_length_and_valid_json() {
        let mut out = Vec::new();
        let n = jsonl(&mut out, 10_000, 200).unwrap();
        assert_eq!(n, 50);
        assert_eq!(out.len(), 10_000);
        for line in out.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
            assert_eq!(line.len(), 199);
            let s = std::str::from_utf8(line).unwrap();
            assert!(s.starts_with("{\"ts\":\"2026-10-20T"), "{s}");
            assert!(s.ends_with("\"}"), "{s}");
        }
    }

    #[test]
    fn huge_record_has_the_requested_payload() {
        let mut out = Vec::new();
        huge_record(&mut out, 1000).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.ends_with("\"}\n"));
        assert_eq!(s.matches('a').count(), 1000);
    }
}
```
`spikes/core/fixtures-gen/src/main.rs`:
```rust
fn main() {}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: FAIL with `not yet implemented`.

- [ ] **Step 3: Implement the generators and the CLI**

Replace the two stub functions (`jsonl` and `huge_record`, signatures included) in `src/lib.rs` with:
```rust
pub fn jsonl<W: Write>(w: &mut W, target_bytes: u64, line_len: usize) -> io::Result<u64> {
    let mut written = 0u64;
    let mut n = 0u64;
    while written < target_bytes {
        let head = format!(
            "{{\"ts\":\"2026-10-20T12:{:02}:{:02}.{:03}Z\",\"type\":\"{}\",\"msg\":\"line {:010} ",
            (n / 60_000) % 60,
            (n / 1000) % 60,
            n % 1000,
            TYPES[(n % 4) as usize],
            n
        );
        let tail = "\"}\n";
        assert!(line_len >= head.len() + tail.len(), "line_len too small");
        w.write_all(head.as_bytes())?;
        w.write_all(&vec![b'x'; line_len - head.len() - tail.len()])?;
        w.write_all(tail.as_bytes())?;
        written += line_len as u64;
        n += 1;
    }
    Ok(n)
}

pub fn huge_record<W: Write>(w: &mut W, payload_bytes: u64) -> io::Result<()> {
    w.write_all(b"{\"ts\":\"2026-10-20T12:00:00.000Z\",\"type\":\"blob\",\"msg\":\"")?;
    let block = vec![b'a'; 1 << 20];
    let mut left = payload_bytes;
    while left > 0 {
        let take = left.min(block.len() as u64) as usize;
        w.write_all(&block[..take])?;
        left -= take as u64;
    }
    w.write_all(b"\"}\n")
}
```
Replace `src/main.rs`:
```rust
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone());
    let num = |name: &str, default: u64| flag(name).map(|v| v.parse().expect("number")).unwrap_or(default);
    let out = flag("--out").expect("--out <path>");
    if let Some(dir) = Path::new(&out).parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut w = BufWriter::with_capacity(8 << 20, File::create(&out)?);
    match args.first().map(String::as_str) {
        Some("jsonl") => {
            let n = fixtures_gen::jsonl(&mut w, num("--bytes", 1 << 30), num("--line", 200) as usize)?;
            eprintln!("{out}: {n} lines");
        }
        Some("jsonl-huge-first") => {
            fixtures_gen::huge_record(&mut w, num("--first", 200 << 20))?;
            let n = fixtures_gen::jsonl(&mut w, num("--bytes", 1 << 20), num("--line", 200) as usize)?;
            eprintln!("{out}: 1 huge record + {n} lines");
        }
        other => panic!("unknown fixture kind {other:?}"),
    }
    w.flush()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p fixtures-gen`
Expected: `2 passed`.

- [ ] **Step 5: Generate the Spike A fixtures**

Run (`spikes/core`):
```bash
cargo run --release -p fixtures-gen -- jsonl --bytes 1073741824 --line 200 --out ../.fixtures/1g.jsonl
cargo run --release -p fixtures-gen -- jsonl --bytes 10737418240 --line 200 --out ../.fixtures/10g.jsonl
cargo run --release -p fixtures-gen -- jsonl-huge-first --first 209715200 --bytes 1048576 --line 200 --out ../.fixtures/huge-first.jsonl
cargo run --release -p fixtures-gen -- jsonl-huge-first --first 1073741824 --bytes 0 --out ../.fixtures/one-line.jsonl
```
Expected:
- `../.fixtures/1g.jsonl: 5368710 lines`
- `../.fixtures/10g.jsonl: 53687092 lines`
- `../.fixtures/huge-first.jsonl: 1 huge record + 5243 lines`
- `../.fixtures/one-line.jsonl: 1 huge record + 0 lines`: 1 GiB on a single line, for Z37's first screen (Task 10).

Spec §13.1 also lists two CSV fixtures for Spike A, but no Spike A gate uses them:
- The 100MB CSV feeds the CSV index throughput measurement (spec §3.5). That measurement needs the CSV record index, which Spike C builds, so the fixture moves to Spike C.
- The 5,000-column CSV needs the Grid, which Spike B builds, so it moves to Spike B.

- [ ] **Step 6: Read your own work (rule 8), then commit**

```bash
git add spikes/core/Cargo.toml spikes/core/Cargo.lock spikes/core/fixtures-gen
git commit -m "spike(base): deterministic JSONL fixture generator"
```

---

## Task 3: Perf primitives and the NetLog assertion tool

**Files:**
- Create: `spikes/app/src/renderer/src/perf.ts`, `spikes/app/src/renderer/src/perf.test.ts`
- Create: `spikes/tools/netlog-assert.mjs`, `spikes/tools/netlog-assert.test.mjs`

**Interfaces:**
- **Produces (perf.ts):**
  - `percentile(values: number[], p: number): number`. Nearest-rank method; `NaN` for empty input.
  - `frameStats(deltas: number[], longFrameMs = 20, stallMs = 50): FrameStats`, where `FrameStats` is `{ frames, longFrames, longShare, maxGap, stalls }`.
    - A long frame is a `requestAnimationFrame` interval over 20ms. That's 16.7ms plus refresh jitter: a 60Hz frame that met its budget never reaches it, and a dropped one always does.
    - Spec §10.3 names Chromium tracing as the source of frame timing. rAF intervals are the spike's stand-in (recorded in the notes at the end).
  - `class PerfLog`:
    - `marks: Record<string, number>`, `fetches: number[]`, `inputLatency: number[]`;
    - `mark(name)`;
    - `fetch(ms)`;
    - `startFrames(probe?: () => number)`;
    - `stopFrames(): FrameStats & { maxStep: number }`. `maxStep` is the largest per-frame change of `probe()`, such as the scroll position.
- **Produces (netlog-assert.mjs):**
  - `parseNetLog(text)` tolerates a log that was cut off.
  - `checkNetLog(json: { constants, events }, allow: string[]): string[]` returns the violations:
    - URL requests outside `allow`, where a `blob:` URL counts as its minting origin's scheme;
    - DNS (`HOST_RESOLVER_*`, `DNS_TRANSACTION`);
    - proxy auto-detection (`WPAD_*`, `PAC_FILE_*`);
    - sockets (`TCP_CONNECT`, `TCP_CONNECT_ATTEMPT`, `UDP_CONNECT`, `SSL_CONNECT`, `QUIC_SESSION`).
  - **Scope:** a NetLog shows Chromium's network stack only. Node sockets in main or the core host never appear in it, and the PASS line says so.
  - CLI: `node netlog-assert.mjs <file> [--allow typose,data,blob]`. Exit code 0 means clean, 1 means violations.

- [ ] **Step 1: Write the failing tests**

`spikes/app/src/renderer/src/perf.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { frameStats, percentile } from './perf'

describe('percentile', () => {
  it('uses the nearest-rank method', () => {
    const v = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10]
    expect(percentile(v, 50)).toBe(5)
    expect(percentile(v, 95)).toBe(10)
    expect(percentile(v, 100)).toBe(10)
  })
  it('is NaN for no samples', () => {
    expect(percentile([], 50)).toBeNaN()
  })
})

describe('frameStats', () => {
  it('counts frames over 20ms as long and gaps over 50ms as stalls', () => {
    const s = frameStats([16.6, 16.8, 33.4, 16.7, 70])
    expect(s.frames).toBe(5)
    expect(s.longFrames).toBe(2)
    expect(s.longShare).toBeCloseTo(0.4)
    expect(s.maxGap).toBe(70)
    expect(s.stalls).toBe(1)
  })
})
```
`spikes/tools/netlog-assert.test.mjs`:
```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkNetLog, parseNetLog } from './netlog-assert.mjs'

const constants = {
  logEventTypes: { URL_REQUEST_START_JOB: 1, HOST_RESOLVER_MANAGER_JOB: 2, TCP_CONNECT: 3, SOCKET_ALIVE: 4 }
}
const allow = ['typose', 'data', 'blob']

test('app-scheme requests, end events and non-request events are clean', () => {
  const events = [
    { type: 1, phase: 1, params: { url: 'typose://app/index.html' } },
    { type: 1, phase: 2 },
    { type: 1, params: { url: 'data:image/png;base64,AAAA' } },
    { type: 4, params: {} }
  ]
  assert.deepEqual(checkNetLog({ constants, events }, allow), [])
})

test('outside requests, DNS and sockets are violations', () => {
  const events = [
    { type: 1, params: { url: 'https://example.com/x.png' } },
    { type: 2, params: { host: 'example.com' } },
    { type: 3, params: { address: '93.184.216.34:443' } }
  ]
  assert.equal(checkNetLog({ constants, events }, allow).length, 3)
})

test('proxy auto-detection, DNS transactions, connect attempts, QUIC and foreign blobs are violations', () => {
  const c = {
    logEventTypes: {
      WPAD_DHCP_WIN_FETCH: 1,
      PAC_FILE_DECIDER: 2,
      DNS_TRANSACTION: 3,
      TCP_CONNECT_ATTEMPT: 4,
      QUIC_SESSION: 5,
      URL_REQUEST_START_JOB: 6,
      QUIC_SESSION_POOL_CLOSE_ALL_SESSIONS: 7
    }
  }
  const events = [1, 2, 3, 4, 5].map((type) => ({ type, params: {} }))
  events.push({ type: 6, params: { url: 'blob:https://evil.example/uuid' } })
  assert.equal(checkNetLog({ constants: c, events }, allow).length, 6)
  const clean = [
    { type: 6, params: { url: 'blob:typose://app/uuid' } },
    { type: 7, params: {} }
  ]
  assert.deepEqual(checkNetLog({ constants: c, events: clean }, allow), [])
})

test('a log cut off mid-write still parses', () => {
  const text = '{"constants":{"logEventTypes":{"TCP_CONNECT":3}},"events":[{"type":3,"params":{}},\n'
  const json = parseNetLog(text)
  assert.equal(json.events.length, 1)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run (`spikes/app`): `npx vitest run src/renderer/src/perf.test.ts`
Expected: FAIL, because it can't resolve `./perf`.

Run (`spikes/tools`): `node --test`
Expected: FAIL, with `Cannot find module` for `netlog-assert.mjs`.

- [ ] **Step 3: Implement both**

`spikes/app/src/renderer/src/perf.ts`:
```ts
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]
}

export interface FrameStats {
  frames: number
  longFrames: number
  longShare: number
  maxGap: number
  stalls: number
}

export function frameStats(deltas: number[], longFrameMs = 20, stallMs = 50): FrameStats {
  const longFrames = deltas.filter((d) => d > longFrameMs).length
  return {
    frames: deltas.length,
    longFrames,
    longShare: deltas.length ? longFrames / deltas.length : 0,
    maxGap: deltas.length ? Math.max(...deltas) : 0,
    stalls: deltas.filter((d) => d > stallMs).length
  }
}

export class PerfLog {
  marks: Record<string, number> = {}
  fetches: number[] = []
  inputLatency: number[] = []
  private deltas: number[] = []
  private steps: number[] = []
  private sampling = false

  mark(name: string): void {
    this.marks[name] = performance.now()
  }

  fetch(ms: number): void {
    this.fetches.push(ms)
  }

  /** Samples rAF intervals; with a probe, also the per-frame change of the probed value (e.g. scroll top). */
  startFrames(probe?: () => number): void {
    this.deltas = []
    this.steps = []
    this.sampling = true
    let last = performance.now()
    let value = probe?.() ?? 0
    const tick = (now: number): void => {
      if (!this.sampling) return
      this.deltas.push(now - last)
      last = now
      if (probe) {
        const next = probe()
        this.steps.push(Math.abs(next - value))
        value = next
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  stopFrames(): FrameStats & { maxStep: number } {
    this.sampling = false
    return { ...frameStats(this.deltas.slice(1)), maxStep: Math.max(0, ...this.steps) }
  }
}
```
`spikes/tools/netlog-assert.mjs`:
```js
// NetLog assertion (spec §7.3): no outside-scheme URL request, no DNS resolution, no proxy auto-detection, no socket connect.
// It sees Chromium's network stack only: Node sockets in main or the core host never appear in a NetLog.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DNS = /^(HOST_RESOLVER_|DNS_TRANSACTION)/
const PROXY = /^(WPAD_|PAC_FILE_)/
const SOCKET = /^(TCP_CONNECT|TCP_CONNECT_ATTEMPT|UDP_CONNECT|SSL_CONNECT|QUIC_SESSION)$/

/** Parses a NetLog file, tolerating a log that was cut off before its closing brackets. */
export function parseNetLog(text) {
  try {
    return JSON.parse(text)
  } catch {
    const trimmed = text.trimEnd().replace(/,$/, '')
    return JSON.parse(`${trimmed}]}`)
  }
}

export function checkNetLog(json, allow) {
  const names = Object.fromEntries(Object.entries(json.constants.logEventTypes).map(([name, id]) => [id, name]))
  const violations = []
  for (const e of json.events ?? []) {
    const name = names[e.type]
    if (name === 'URL_REQUEST_START_JOB') {
      // Only the begin event carries the URL; the end event has no params.
      const url = e.params?.url
      // A blob: URL is only as local as the origin that minted it.
      const scheme = url?.startsWith('blob:') ? `blob:${url.slice(5).split(':')[0]}` : url?.split(':')[0]
      if (url && !(allow.includes(scheme) || (scheme.startsWith('blob:') && allow.includes(scheme.slice(5)))))
        violations.push(`request ${url}`)
    } else if (name && DNS.test(name)) {
      violations.push(`dns ${name} ${JSON.stringify(e.params ?? {})}`)
    } else if (name && PROXY.test(name)) {
      violations.push(`proxy ${name} ${JSON.stringify(e.params ?? {})}`)
    } else if (name && SOCKET.test(name)) {
      violations.push(`socket ${name} ${JSON.stringify(e.params ?? {})}`)
    }
  }
  return violations
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowArg = process.argv.indexOf('--allow')
  const allow = allowArg > 0 ? process.argv[allowArg + 1].split(',') : ['typose', 'data', 'blob']
  const violations = checkNetLog(parseNetLog(readFileSync(process.argv[2], 'utf8')), allow)
  for (const v of violations) console.log(v)
  console.log(
    violations.length
      ? `FAIL: ${violations.length} violation(s)`
      : 'PASS: no Chromium network-stack activity (Node sockets in main/core host are not covered)'
  )
  process.exit(violations.length ? 1 : 0)
}
```

- [ ] **Step 4: Run them to verify they pass**

Run (`spikes/app`): `npx vitest run src/renderer/src/perf.test.ts`
Expected: `3 passed`.

Run (`spikes/tools`): `node --test`
Expected: `ℹ pass 4`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src/perf.ts spikes/app/src/renderer/src/perf.test.ts spikes/tools
git commit -m "spike(base): percentile/frame stats and NetLog assertion tool"
```

Base harness done. Run `git switch -c spike/a` and continue with Task 4.

---

## Task 4: ByteStore — positional reads, 1MiB chunks, hash-verified, cached

**Files:**
- Modify: `spikes/core/spike-core/Cargo.toml` (dependencies)
- Create: `spikes/core/spike-core/src/store.rs`
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod store;`)

**Interfaces:**
- **Produces:**
  - `pub const CHUNK: usize = 1 << 20;`
  - `pub enum StoreError { Io(io::Error), Changed { chunk: u64 } }`, which implements `Display`, `From<io::Error>`.
  - `pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize>`
  - `pub fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()>`
  - `pub struct ChunkHashes` (`Default`):
    - `check(&self, chunk: u64, data: &[u8]) -> Result<(), StoreError>` records the hash on first sight and verifies it afterwards;
    - `len(&self) -> usize`.
  - `pub struct ByteStore`:
    - `open(path: &Path) -> io::Result<ByteStore>`;
    - `open_with(path: &Path, cache_chunks: usize) -> io::Result<ByteStore>`;
    - `len(&self) -> u64`;
    - `hashes(&self) -> Arc<ChunkHashes>`;
    - `chunk(&self, idx: u64) -> Result<Arc<Vec<u8>>, StoreError>`;
    - `read(&self, start: u64, end: u64) -> Result<Vec<u8>, StoreError>`.
  - `#[cfg(test)] pub(crate) mod testutil { pub fn temp_file(name: &str, bytes: &[u8]) -> PathBuf }`.

- [ ] **Step 1: Add dependencies and write the failing tests**

In `spikes/core/spike-core/Cargo.toml`, replace `[dependencies]` with:
```toml
[dependencies]
memchr = "2.8"
serde_json = "1"
xxhash-rust = { version = "0.8", features = ["xxh3"] }

[dev-dependencies]
proptest = "1.12"
```
Add `pub mod store;` to `src/lib.rs`, above the `version` function.

`spikes/core/spike-core/src/store.rs`:
```rust
//! File-backed byte store (spec §3.1, §3.3): positional reads only, never mmap.
//! Every 1MiB chunk is hashed the first time it's read and verified on every later read.
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use xxhash_rust::xxh3::xxh3_64;

pub const CHUNK: usize = 1 << 20;
const DEFAULT_CACHE_CHUNKS: usize = 64;

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    /// The bytes on disk no longer match the version first read.
    Changed { chunk: u64 },
}

#[derive(Default)]
pub struct ChunkHashes(Mutex<HashMap<u64, u64>>);

pub struct ByteStore {
    file: File,
    len: u64,
    hashes: Arc<ChunkHashes>,
    cache: Mutex<VecDeque<(u64, Arc<Vec<u8>>)>>,
    cache_chunks: usize,
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::PathBuf;

    /// Writes `bytes` to a unique temp file and returns its path.
    pub fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("spike-core-{}-{}", std::process::id(), name));
        std::fs::write(&path, bytes).unwrap();
        path
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::temp_file;
    use super::*;
    use std::io::{Seek, SeekFrom, Write};

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn reads_across_chunk_boundaries() {
        let data = pattern(3 * CHUNK + 17);
        let store = ByteStore::open(&temp_file("cross", &data)).unwrap();
        let (a, b) = (CHUNK as u64 - 5, 2 * CHUNK as u64 + 9);
        assert_eq!(store.read(a, b).unwrap(), data[a as usize..b as usize]);
        assert_eq!(store.read(3 * CHUNK as u64, 10 * CHUNK as u64).unwrap(), data[3 * CHUNK..]);
    }

    #[test]
    fn a_changed_chunk_is_detected_on_reread() {
        let data = pattern(2 * CHUNK);
        let path = temp_file("changed", &data);
        let store = ByteStore::open_with(&path, 1).unwrap();
        store.chunk(0).unwrap();
        store.chunk(1).unwrap(); // evicts chunk 0 from the one-chunk cache
        let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.seek(SeekFrom::Start(10)).unwrap();
        f.write_all(b"same-size in-place write").unwrap();
        drop(f);
        assert!(matches!(store.chunk(0), Err(StoreError::Changed { chunk: 0 })));
    }

    #[test]
    fn a_truncated_file_reads_as_changed() {
        let data = pattern(2 * CHUNK);
        let path = temp_file("truncated", &data);
        let store = ByteStore::open(&path).unwrap();
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(10).unwrap();
        assert!(matches!(store.chunk(1), Err(StoreError::Changed { chunk: 1 })));
    }

    #[test]
    fn the_file_stays_deletable_while_open() {
        let path = temp_file("deletable", &pattern(100));
        let store = ByteStore::open(&path).unwrap();
        store.chunk(0).unwrap();
        std::fs::remove_file(&path).expect("Typose must never lock a file (brief §7.9)");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core store`
Expected: compile errors E0599, no function `open` / `open_with` found for `ByteStore`. These mask the missing `chunk` and `read`.

- [ ] **Step 3: Implement**

Add to `store.rs`, between the `ByteStore` struct and the `testutil` module:
```rust
impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "io: {e}"),
            StoreError::Changed { chunk } => write!(f, "changed on disk (chunk {chunk})"),
        }
    }
}

pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buf, offset)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buf, offset)
    }
}

pub fn read_exact_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> io::Result<()> {
    while !buf.is_empty() {
        let n = read_at(file, buf, offset)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "file shorter than expected"));
        }
        buf = &mut buf[n..];
        offset += n as u64;
    }
    Ok(())
}

impl ChunkHashes {
    /// Records the chunk's hash the first time it's seen; afterwards, verifies against it.
    pub fn check(&self, chunk: u64, data: &[u8]) -> Result<(), StoreError> {
        let hash = xxh3_64(data);
        let mut map = self.0.lock().unwrap();
        match map.get(&chunk) {
            Some(&known) if known != hash => Err(StoreError::Changed { chunk }),
            Some(_) => Ok(()),
            None => {
                map.insert(chunk, hash);
                Ok(())
            }
        }
    }

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

impl ByteStore {
    pub fn open(path: &Path) -> io::Result<ByteStore> {
        Self::open_with(path, DEFAULT_CACHE_CHUNKS)
    }

    pub fn open_with(path: &Path, cache_chunks: usize) -> io::Result<ByteStore> {
        let file = File::open(path)?; // Windows default share mode: READ | WRITE | DELETE
        let len = file.metadata()?.len();
        Ok(ByteStore {
            file,
            len,
            hashes: Arc::new(ChunkHashes::default()),
            cache: Mutex::new(VecDeque::new()),
            cache_chunks: cache_chunks.max(1),
        })
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn hashes(&self) -> Arc<ChunkHashes> {
        self.hashes.clone()
    }

    pub fn chunk(&self, idx: u64) -> Result<Arc<Vec<u8>>, StoreError> {
        if let Some((_, hit)) = self.cache.lock().unwrap().iter().find(|(i, _)| *i == idx) {
            return Ok(hit.clone());
        }
        let start = idx * CHUNK as u64;
        let size = self.len.saturating_sub(start).min(CHUNK as u64) as usize;
        let mut buf = vec![0u8; size];
        read_exact_at(&self.file, &mut buf, start).map_err(|e| match e.kind() {
            io::ErrorKind::UnexpectedEof => StoreError::Changed { chunk: idx },
            _ => StoreError::Io(e),
        })?;
        self.hashes.check(idx, &buf)?;
        let data = Arc::new(buf);
        let mut cache = self.cache.lock().unwrap();
        cache.push_back((idx, data.clone()));
        // ponytail: FIFO eviction, not LRU. Switch to LRU if Spike A shows cache thrash while scrolling.
        if cache.len() > self.cache_chunks {
            cache.pop_front();
        }
        Ok(data)
    }

    pub fn read(&self, start: u64, end: u64) -> Result<Vec<u8>, StoreError> {
        let end = end.min(self.len);
        let mut out = Vec::with_capacity(end.saturating_sub(start) as usize);
        let mut pos = start;
        while pos < end {
            let idx = pos / CHUNK as u64;
            let data = self.chunk(idx)?;
            let off = (pos - idx * CHUNK as u64) as usize;
            let take = ((end - pos) as usize).min(data.len().saturating_sub(off));
            if take == 0 {
                break;
            }
            out.extend_from_slice(&data[off..off + take]);
            pos += take as u64;
        }
        Ok(out)
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core store`
Expected: `4 passed`. On Windows, `the_file_stays_deletable_while_open` proves the share mode.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core spikes/core/Cargo.lock
git commit -m "spike(a): hash-verified chunked byte store with positional reads"
```

---

## Task 5: LineIndex — streaming build, byte-bounded checkpoints, locate_line

**Files:**
- Create: `spikes/core/spike-core/src/index.rs`
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod index;`)

**Interfaces:**
- **Consumes:** `store::{ByteStore, ChunkHashes, StoreError, CHUNK, read_exact_at}`.
- **Produces:**
  - `pub struct Checkpoint { pub line: u64, pub offset: u64, pub at_line_start: bool }`.
    - `line` is the 0-based line containing `offset`.
    - `at_line_start` is false for a checkpoint placed mid-line by the byte bound.
  - `pub struct IndexConfig { pub cp_lines: u64, pub cp_bytes: u64, pub block: usize }`. Defaults: 1024, 1 MiB, 4 MiB.
  - `pub struct LineIndex { pub checkpoints, pub newlines, pub last_line_start, pub indexed_bytes, pub done }`, with:
    - `line_count(&self) -> u64` (it counts a non-empty tail with no trailing newline). While indexing, that tail is the line the scan is inside, so it already counts as a line, and the progress event's `lines` includes it (Z37);
    - `checkpoint_for(&self, line: u64) -> Checkpoint`.
  - `pub struct Progress { pub lines: u64, pub bytes: u64, pub done: bool, pub elapsed_ms: u64 }`
  - `pub fn build(file: &File, len: u64, cfg: IndexConfig, hashes: &ChunkHashes, shared: &RwLock<LineIndex>, on_progress: impl FnMut(Progress)) -> Result<(), StoreError>`. It publishes into `shared` after every block, calls `on_progress` after every block and again when done, and hashes every chunk it reads.
  - `pub fn locate_line(store: &ByteStore, index: &LineIndex, line: u64) -> Result<Option<u64>, StoreError>`. It returns the byte offset where `line` starts, and scans at most `cp_bytes` past a checkpoint.
  - **Private, reused by Task 12:** `struct Builder`, `fn read_block`, `fn block_len`.

**Design note:**
- Checkpoints are placed every `cp_lines` newlines, **or** every `cp_bytes` bytes, whichever comes first.
- Inside a long line, the byte bound places mid-line checkpoints. So consecutive checkpoints are never more than `cp_bytes` apart, and no rescan reads more than 1 MiB (spec §3.5).
- `Builder` turns newline positions into checkpoints, separately from how blocks are read. Task 12 can then swap in a parallel reader without touching the checkpoint logic.

- [ ] **Step 1: Write the failing tests**

Add `pub mod index;` to `lib.rs`, on the line above `pub mod store;`. `spikes/core/spike-core/src/index.rs`:
```rust
//! Streaming line index with byte-bounded checkpoints (spec §3.5).
use std::fs::File;
use std::sync::RwLock;
use std::time::Instant;

use memchr::memchr_iter;

use crate::store::{read_exact_at, ByteStore, ChunkHashes, StoreError, CHUNK};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub line: u64,
    pub offset: u64,
    pub at_line_start: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct IndexConfig {
    pub cp_lines: u64,
    pub cp_bytes: u64,
    pub block: usize,
}

impl Default for IndexConfig {
    fn default() -> Self {
        IndexConfig { cp_lines: 1024, cp_bytes: 1 << 20, block: 4 << 20 }
    }
}

#[derive(Debug, Default)]
pub struct LineIndex {
    pub checkpoints: Vec<Checkpoint>,
    pub newlines: u64,
    pub last_line_start: u64,
    pub indexed_bytes: u64,
    pub done: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Progress {
    pub lines: u64,
    pub bytes: u64,
    pub done: bool,
    pub elapsed_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::testutil::temp_file;
    use proptest::prelude::*;

    fn index_bytes(name: &str, bytes: &[u8], cfg: IndexConfig) -> (ByteStore, LineIndex) {
        let path = temp_file(name, bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex::default());
        let file = File::open(&path).unwrap();
        build(&file, store.len(), cfg, &store.hashes(), &shared, |_| {}).unwrap();
        (store, shared.into_inner().unwrap())
    }

    fn naive_line_starts(bytes: &[u8]) -> Vec<u64> {
        if bytes.is_empty() {
            return vec![];
        }
        let mut starts = vec![0u64];
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' && i + 1 < bytes.len() {
                starts.push(i as u64 + 1);
            }
        }
        starts
    }

    #[test]
    fn checkpoints_every_n_lines() {
        let cfg = IndexConfig { cp_lines: 3, cp_bytes: 1 << 20, block: CHUNK };
        let (_, idx) = index_bytes("every-n", "a\n".repeat(10).as_bytes(), cfg);
        let starts: Vec<(u64, u64)> = idx.checkpoints.iter().map(|c| (c.line, c.offset)).collect();
        assert_eq!(starts, vec![(0, 0), (3, 6), (6, 12), (9, 18)]);
        assert_eq!(idx.line_count(), 10);
        assert!(idx.done);
    }

    #[test]
    fn byte_bound_places_checkpoints_inside_a_long_line() {
        let cfg = IndexConfig { cp_lines: 1024, cp_bytes: 4, block: CHUNK };
        let (store, idx) = index_bytes("long-line", b"xxxxxxxxxx\ny\n", cfg);
        let cps: Vec<(u64, u64, bool)> = idx.checkpoints.iter().map(|c| (c.line, c.offset, c.at_line_start)).collect();
        assert_eq!(cps, vec![(0, 0, true), (0, 4, false), (0, 8, false), (1, 12, false)]);
        assert_eq!(idx.line_count(), 2);
        assert_eq!(locate_line(&store, &idx, 1).unwrap(), Some(11));
        assert_eq!(locate_line(&store, &idx, 2).unwrap(), None);
    }

    #[test]
    fn a_tail_without_a_newline_is_a_line() {
        let (store, idx) = index_bytes("tail", b"a\nb", IndexConfig::default());
        assert_eq!(idx.line_count(), 2);
        assert_eq!(locate_line(&store, &idx, 1).unwrap(), Some(2));
    }

    #[test]
    fn every_chunk_gets_hashed() {
        let bytes = vec![b'z'; 2 * CHUNK + 1];
        let (store, _) = index_bytes("hashed", &bytes, IndexConfig::default());
        assert_eq!(store.hashes().len(), 3);
    }

    proptest! {
        #[test]
        fn locate_line_matches_a_naive_scan(
            bytes in prop::collection::vec(prop_oneof![Just(b'\n'), Just(b'a'), Just(b'\r')], 0..4000),
            cp_lines in 1u64..50,
            cp_bytes in 1u64..300,
        ) {
            let cfg = IndexConfig { cp_lines, cp_bytes, block: CHUNK };
            let (store, idx) = index_bytes("prop", &bytes, cfg);
            let starts = naive_line_starts(&bytes);
            prop_assert_eq!(idx.line_count(), starts.len() as u64);
            for (line, &start) in starts.iter().enumerate() {
                prop_assert_eq!(locate_line(&store, &idx, line as u64).unwrap(), Some(start));
            }
            for pair in idx.checkpoints.windows(2) {
                prop_assert!(pair[1].offset - pair[0].offset <= cp_bytes, "checkpoint gap over cp_bytes");
            }
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core index`
Expected: compile errors, E0425 for `build` and `locate_line` and E0599 for `line_count`. The tests don't call `checkpoint_for` directly.

- [ ] **Step 3: Implement**

Add to `index.rs`, below the `Progress` struct:
```rust
impl LineIndex {
    pub fn line_count(&self) -> u64 {
        self.newlines + u64::from(self.indexed_bytes > self.last_line_start)
    }

    /// The last checkpoint at or before `line`'s start: either `line`'s own start,
    /// or a checkpoint inside an earlier line. The predicate below is monotonic over `checkpoints`.
    pub fn checkpoint_for(&self, line: u64) -> Checkpoint {
        let i = self
            .checkpoints
            .partition_point(|c| c.line < line || (c.line == line && c.at_line_start));
        self.checkpoints[i.saturating_sub(1)]
    }
}

/// Turns newline positions into checkpoints. Whatever reads the blocks feeds them here in file order.
struct Builder {
    cfg: IndexConfig,
    fresh: Vec<Checkpoint>,
    newlines: u64,
    last_line_start: u64,
    last_cp: u64,
    lines_since: u64,
}

impl Builder {
    fn new(cfg: IndexConfig) -> Builder {
        Builder {
            cfg,
            fresh: vec![Checkpoint { line: 0, offset: 0, at_line_start: true }],
            newlines: 0,
            last_line_start: 0,
            last_cp: 0,
            lines_since: 0,
        }
    }

    /// One block `[start, end)`; `rels` are its newline positions relative to `start`, ascending.
    fn block(&mut self, start: u64, end: u64, rels: impl Iterator<Item = usize>) {
        let cp_bytes = self.cfg.cp_bytes;
        for rel in rels {
            let line_start = start + rel as u64 + 1;
            while self.last_cp + cp_bytes < line_start {
                self.last_cp += cp_bytes;
                self.fresh.push(Checkpoint { line: self.newlines, offset: self.last_cp, at_line_start: false });
            }
            self.newlines += 1;
            self.lines_since += 1;
            self.last_line_start = line_start;
            if self.lines_since >= self.cfg.cp_lines || line_start - self.last_cp >= cp_bytes {
                self.fresh.push(Checkpoint { line: self.newlines, offset: line_start, at_line_start: true });
                self.last_cp = line_start;
                self.lines_since = 0;
            }
        }
        while self.last_cp + cp_bytes <= end {
            self.last_cp += cp_bytes;
            self.fresh.push(Checkpoint { line: self.newlines, offset: self.last_cp, at_line_start: false });
        }
    }

    /// Moves the new checkpoints into the shared index and returns its line count.
    fn publish(&mut self, shared: &RwLock<LineIndex>, indexed: u64, done: bool) -> u64 {
        let mut w = shared.write().unwrap();
        w.checkpoints.append(&mut self.fresh);
        w.newlines = self.newlines;
        w.last_line_start = self.last_line_start;
        w.indexed_bytes = indexed;
        w.done = done;
        w.line_count()
    }
}

/// Reads one chunk-aligned block at `pos` and hashes every chunk in it.
fn read_block<'a>(file: &File, block: &'a mut [u8], pos: u64, hashes: &ChunkHashes) -> Result<&'a [u8], StoreError> {
    read_exact_at(file, block, pos).map_err(|e| match e.kind() {
        std::io::ErrorKind::UnexpectedEof => StoreError::Changed { chunk: pos / CHUNK as u64 },
        _ => StoreError::Io(e),
    })?;
    for (i, chunk) in block.chunks(CHUNK).enumerate() {
        hashes.check(pos / CHUNK as u64 + i as u64, chunk)?;
    }
    Ok(block)
}

fn block_len(cfg: &IndexConfig) -> usize {
    cfg.block.max(CHUNK) / CHUNK * CHUNK // whole chunks, so every hash covers exactly one chunk
}

pub fn build(
    file: &File,
    len: u64,
    cfg: IndexConfig,
    hashes: &ChunkHashes,
    shared: &RwLock<LineIndex>,
    mut on_progress: impl FnMut(Progress),
) -> Result<(), StoreError> {
    let started = Instant::now();
    let mut b = Builder::new(cfg);
    let mut buf = vec![0u8; block_len(&cfg)];
    let mut pos = 0u64;
    while pos < len {
        let n = ((len - pos) as usize).min(buf.len());
        let block = read_block(file, &mut buf[..n], pos, hashes)?;
        b.block(pos, pos + n as u64, memchr_iter(b'\n', block));
        pos += n as u64;
        let lines = b.publish(shared, pos, false);
        on_progress(Progress { lines, bytes: pos, done: false, elapsed_ms: started.elapsed().as_millis() as u64 });
    }
    let lines = b.publish(shared, len, true);
    on_progress(Progress { lines, bytes: len, done: true, elapsed_ms: started.elapsed().as_millis() as u64 });
    Ok(())
}

pub fn locate_line(store: &ByteStore, index: &LineIndex, line: u64) -> Result<Option<u64>, StoreError> {
    if line >= index.line_count() {
        return Ok(None);
    }
    let cp = index.checkpoint_for(line);
    if cp.line == line && cp.at_line_start {
        return Ok(Some(cp.offset));
    }
    let mut need = line - cp.line;
    let mut pos = cp.offset;
    while pos < index.indexed_bytes {
        let end = (pos + CHUNK as u64).min(index.indexed_bytes);
        let bytes = store.read(pos, end)?;
        for rel in memchr_iter(b'\n', &bytes) {
            need -= 1;
            if need == 0 {
                return Ok(Some(pos + rel as u64 + 1));
            }
        }
        pos = end;
    }
    Ok(None)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/core`): `cargo test -p spike-core index`
Expected: `5 passed`; the proptest runs its 256 default cases.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core
git commit -m "spike(a): streaming line index with byte-bounded checkpoints"
```

---

## Task 6: Pages — bounded line pieces and Rows summaries

**Files:**
- Create: `spikes/core/spike-core/src/pages.rs`
- Modify: `spikes/core/spike-core/src/lib.rs` (`pub mod pages;`)

**Interfaces:**
- **Consumes:** `index::{LineIndex, locate_line}` and `store::{ByteStore, StoreError}`.
- **Produces:**
  - `pub const MAX_PIECE: usize = 65_536; pub const MAX_PAGE: usize = 262_144;`
  - `pub struct LinePiece { pub line: u64, pub offset: u64, pub text: String, pub more: bool }`. `text` is ≤ `MAX_PIECE` bytes before lossy decoding, with any trailing `\r` stripped. `more` means the line continues past this piece.
  - `pub struct RowSummary { pub line: u64, pub ts: Option<String>, pub kind: Option<String>, pub summary: String, pub more: bool, pub bad: bool }`
  - `pub fn lines(store: &ByteStore, index: &LineIndex, start: u64, count: u32) -> Result<Vec<LinePiece>, StoreError>`. It returns ≤ `count` pieces, and stops before a piece would take the page past `MAX_PAGE` bytes (the first piece always fits, since a piece is ≤ 64 KiB). The renderer re-requests the rest of its range. While indexing, the line the scan is inside counts as a line (`line_count`), so `lines` returns its first piece, with `more`, before its newline is found (Z37).
  - `pub fn piece(store: &ByteStore, line: u64, offset: u64) -> Result<LinePiece, StoreError>`: spec §3.4's continuation (Z37). It returns the bounded piece of `line` that starts at byte `offset`; a piece with `more` continues at `offset + MAX_PIECE`. It reads the file, not the index, so it works while indexing proceeds. At a line's start it returns exactly what `lines` does; past the end of the file, an empty piece without `more`.
  - `pub fn rows(store: &ByteStore, index: &LineIndex, start: u64, count: u32) -> Result<Vec<RowSummary>, StoreError>`. The row anatomy follows brief §5.4.

**Scope:**
- Bytes are decoded with UTF-8 `from_utf8_lossy` here; byte maps across encodings are Spike C's job.
- A Raw line over 64 KiB shows its first piece on one row. `piece` fetches its later pieces on demand (Z37). Rendering them as their own items, and wrapped variable-height lines, are M1 work.
- A line whose text is exactly 64 KiB and ends in `\r\n` comes back as a 64 KiB piece with `more`, then an empty last piece (its `\r`, stripped). `lines` has always behaved the same; the spike leaves it.

- [ ] **Step 1: Write the failing tests**

Add `pub mod pages;` to `lib.rs`, between `pub mod index;` and `pub mod store;`. `spikes/core/spike-core/src/pages.rs`:
```rust
//! Bounded pages (spec §3.4): ≤ 64 KiB per item, ≤ 256 KiB per page.
use memchr::memchr;
use serde_json::Value;

use crate::index::{locate_line, LineIndex};
use crate::store::{ByteStore, StoreError};

pub const MAX_PIECE: usize = 65_536;
pub const MAX_PAGE: usize = 262_144;

#[derive(Debug, Clone, PartialEq)]
pub struct LinePiece {
    pub line: u64,
    pub offset: u64,
    pub text: String,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowSummary {
    pub line: u64,
    pub ts: Option<String>,
    pub kind: Option<String>,
    pub summary: String,
    pub more: bool,
    pub bad: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{build, IndexConfig};
    use crate::store::testutil::temp_file;
    use std::fs::File;
    use std::sync::RwLock;

    fn open(name: &str, bytes: &[u8]) -> (ByteStore, LineIndex) {
        let path = temp_file(name, bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex::default());
        build(&File::open(&path).unwrap(), store.len(), IndexConfig::default(), &store.hashes(), &shared, |_| {}).unwrap();
        (store, shared.into_inner().unwrap())
    }

    #[test]
    fn lines_strip_crlf_and_start_anywhere() {
        let (store, idx) = open("crlf", b"one\r\ntwo\r\nthree");
        let got = lines(&store, &idx, 1, 10).unwrap();
        assert_eq!(got.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["two", "three"]);
        assert!(got.iter().all(|p| !p.more));
        assert_eq!(got[0].offset, 5);
    }

    #[test]
    fn a_huge_line_is_one_bounded_piece_and_the_next_line_follows() {
        let mut bytes = vec![b'x'; 100_000];
        bytes.extend_from_slice(b"\nshort\n");
        let (store, idx) = open("huge", &bytes);
        let got = lines(&store, &idx, 0, 10).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].text.len(), MAX_PIECE);
        assert!(got[0].more);
        assert_eq!(got[1], LinePiece { line: 1, offset: 100_001, text: "short".into(), more: false });
    }

    #[test]
    fn a_page_stops_at_256_kib() {
        let line = format!("{}\n", "y".repeat(60_000));
        let (store, idx) = open("page-cap", line.repeat(10).as_bytes());
        assert_eq!(lines(&store, &idx, 0, 10).unwrap().len(), 4); // 4 × 60,000 ≤ 256 KiB < 5 × 60,000
    }

    #[test]
    fn rows_pick_brief_fields_and_flag_bad_lines() {
        let (store, idx) = open(
            "rows",
            b"{\"ts\":\"12:04\",\"type\":\"tool\",\"msg\":\"read file\"}\nnot json\n{\"level\":\"warn\",\"n\":3}\n",
        );
        let got = rows(&store, &idx, 0, 10).unwrap();
        assert_eq!(got[0].ts.as_deref(), Some("12:04"));
        assert_eq!(got[0].kind.as_deref(), Some("tool"));
        assert_eq!(got[0].summary, "read file");
        assert!(got[1].bad);
        assert_eq!(got[2].kind.as_deref(), Some("warn"));
        assert_eq!(got[2].summary, "{\"level\":\"warn\",\"n\":3}");
    }

    #[test]
    fn while_scanning_the_partial_first_line_shows_its_first_piece_and_continues() {
        // Z37: a 3 MiB first line, indexed 1 MiB at a time. At the first progress event its newline isn't found yet,
        // but it already counts as a line, `lines` returns its first piece, and the next piece is fetchable.
        let mut bytes = vec![b'x'; 3 << 20];
        bytes.extend_from_slice(b"\nshort\n");
        let path = temp_file("mid-index", &bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex::default());
        let cfg = IndexConfig { block: 1 << 20, ..IndexConfig::default() };
        let mut first = None;
        build(&File::open(&path).unwrap(), store.len(), cfg, &store.hashes(), &shared, |p| {
            if first.is_none() {
                let idx = shared.read().unwrap();
                let page = lines(&store, &idx, 0, 10).unwrap();
                let next = piece(&store, 0, MAX_PIECE as u64).unwrap();
                first = Some((p.lines, idx.newlines, page, next));
            }
        })
        .unwrap();
        let (count, newlines, page, next) = first.unwrap();
        assert_eq!((count, newlines, page.len()), (1, 0, 1));
        assert_eq!((page[0].line, page[0].offset, page[0].text.len(), page[0].more), (0, 0, MAX_PIECE, true));
        assert_eq!((next.line, next.offset, next.text.len(), next.more), (0, MAX_PIECE as u64, MAX_PIECE, true));
    }

    #[test]
    fn a_long_line_continues_one_bounded_piece_at_a_time() {
        let mut bytes = vec![b'x'; 2 * MAX_PIECE + 10];
        bytes.extend_from_slice(b"\r\nnext\n");
        let (store, idx) = open("piece-chain", &bytes);
        let first = lines(&store, &idx, 0, 1).unwrap().remove(0);
        assert_eq!(piece(&store, 0, 0).unwrap(), first); // a piece is exactly what `lines` returns at that offset
        let second = piece(&store, 0, first.offset + MAX_PIECE as u64).unwrap();
        let last = piece(&store, 0, second.offset + MAX_PIECE as u64).unwrap();
        assert_eq!((second.offset, second.text.len(), second.more), (MAX_PIECE as u64, MAX_PIECE, true));
        assert_eq!((last.offset, last.text.len(), last.more), (2 * MAX_PIECE as u64, 10, false)); // `\r` stripped
        let past = piece(&store, 0, u64::MAX).unwrap(); // an offset past the end reads nothing, and nothing follows
        assert_eq!((past.text.as_str(), past.more), ("", false));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (`spikes/core`): `cargo test -p spike-core pages`
Expected: compile errors, because `lines`, `rows` and `piece` aren't defined.

- [ ] **Step 3: Implement**

Add to `pages.rs`, above the tests:
```rust
pub fn lines(store: &ByteStore, index: &LineIndex, start: u64, count: u32) -> Result<Vec<LinePiece>, StoreError> {
    let mut out = Vec::new();
    let Some(mut offset) = locate_line(store, index, start)? else { return Ok(out) };
    let total = index.line_count();
    let (mut line, mut page_bytes) = (start, 0usize);
    while line < total && out.len() < count as usize {
        let bytes = store.read(offset, offset + MAX_PIECE as u64 + 1)?;
        match memchr(b'\n', &bytes) {
            Some(i) if i <= MAX_PIECE => {
                if !out.is_empty() && page_bytes + i > MAX_PAGE {
                    break;
                }
                let text = bytes[..i].strip_suffix(b"\r").unwrap_or(&bytes[..i]);
                out.push(LinePiece { line, offset, text: String::from_utf8_lossy(text).into_owned(), more: false });
                page_bytes += i;
                offset += i as u64 + 1;
            }
            _ => {
                let take = bytes.len().min(MAX_PIECE);
                if !out.is_empty() && page_bytes + take > MAX_PAGE {
                    break;
                }
                let ends_here = offset + bytes.len() as u64 >= store.len() && bytes.len() <= MAX_PIECE;
                out.push(LinePiece {
                    line,
                    offset,
                    text: String::from_utf8_lossy(&bytes[..take]).into_owned(),
                    more: !ends_here,
                });
                page_bytes += take;
                match locate_line(store, index, line + 1)? {
                    Some(next) => offset = next,
                    None => break,
                }
            }
        }
        line += 1;
    }
    Ok(out)
}

/// Spec §3.4's continuation (Z37): the bounded piece of `line` that starts at byte `offset`. A piece with `more`
/// continues at its `offset + MAX_PIECE`. It reads the file, not the index, so it works while indexing proceeds.
pub fn piece(store: &ByteStore, line: u64, offset: u64) -> Result<LinePiece, StoreError> {
    let bytes = store.read(offset, offset.saturating_add(MAX_PIECE as u64 + 1))?;
    let (text, more) = match memchr(b'\n', &bytes) {
        Some(i) => (bytes[..i].strip_suffix(b"\r").unwrap_or(&bytes[..i]), false),
        None => (&bytes[..bytes.len().min(MAX_PIECE)], bytes.len() > MAX_PIECE),
    };
    Ok(LinePiece { line, offset, text: String::from_utf8_lossy(text).into_owned(), more })
}

pub fn rows(store: &ByteStore, index: &LineIndex, start: u64, count: u32) -> Result<Vec<RowSummary>, StoreError> {
    Ok(lines(store, index, start, count)?.into_iter().map(summarize).collect())
}

fn summarize(p: LinePiece) -> RowSummary {
    let plain = |bad| RowSummary { line: p.line, ts: None, kind: None, summary: preview(&p.text), more: p.more, bad };
    if p.more {
        return plain(false);
    }
    match serde_json::from_str::<Value>(&p.text) {
        Ok(Value::Object(map)) => {
            let pick = |keys: &[&str]| keys.iter().find_map(|k| map.get(*k)).map(scalar);
            let summary = ["message", "msg", "text", "content", "summary"]
                .iter()
                .find_map(|k| map.get(*k).and_then(Value::as_str))
                .map(preview)
                .unwrap_or_else(|| preview(&p.text));
            RowSummary {
                line: p.line,
                ts: pick(&["ts", "time", "timestamp", "created_at"]),
                kind: pick(&["type", "role", "level", "event"]),
                summary,
                more: false,
                bad: false,
            }
        }
        Ok(_) => plain(false),
        Err(_) => plain(true),
    }
}

fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn preview(s: &str) -> String {
    s.chars().take(200).collect()
}
```

- [ ] **Step 4: Run all core tests**

Run (`spikes/core`): `cargo test -p spike-core`
Expected: `16 passed`, made up of:
- 4 `store` tests;
- 5 `index` tests;
- 6 `pages` tests;
- `version_is_the_crate_version`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core
git commit -m "spike(a): bounded line pieces and Rows summaries"
```

---

## Task 7: napi `Doc`, core-host RPC and streaming progress

**Files:**
- Modify: `spikes/core/spike-node/src/lib.rs` (full replacement below)
- Modify: `spikes/app/src/main/core-host.ts` (full replacement below)
- Create: `spikes/app/e2e/open.e2e.ts`

**Interfaces:**
- **Consumes:**
  - `spike_core::store::ByteStore`;
  - `spike_core::index::{build, IndexConfig, LineIndex}`;
  - `spike_core::pages::{lines, piece, rows}`.
- **Produces:**
  - **napi**, as generated into `index.d.ts` (checked against the real build):
    ```ts
    class Doc {
      static open(path: string): Doc
      get size(): number
      startIndex(onProgress: (arg: IndexProgress) => void): void
      lines(start: number, count: number): Array<JsLine>
      piece(line: number, offset: number): JsLine
      rows(start: number, count: number): Array<JsRow>
    }
    interface IndexProgress { lines: number; bytes: number; done: boolean; elapsedMs: number; error?: string }
    interface JsLine { line: number; offset: number; text: string; more: boolean }
    interface JsRow { line: number; ts?: string; kind?: string; summary: string; more: boolean; bad: boolean }
    ```
  - **RPC methods:**
    - `open {path} → {doc, size}`;
    - `lines {doc, start, count} → JsLine[]`;
    - `piece {doc, line, offset} → JsLine`: the next bounded piece of a long line (spec §3.4's continuation, Z37); a `more` piece continues at `offset + 65,536`;
    - `rows {doc, start, count} → JsRow[]`;
    - `close {doc}`;
    - `version`.
  - **Event:** `{ event: 'progress', doc, lines, bytes, done, elapsedMs, error? }`.
    - Throttled to ≤ 10 Hz, except: the first event, the done event, and any event where the line count grew while fewer than 256 lines were known.
    - An indexing failure sends one event with `error` set.

- [ ] **Step 1: Write the failing e2e test**

`spikes/app/e2e/open.e2e.ts`:
```ts
import { _electron as electron, expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('open streams progress and serves bounded lines', async () => {
  const path = join(tmpdir(), 'spike-open.jsonl')
  writeFileSync(path, Array.from({ length: 5000 }, (_, i) => `{"type":"tool","msg":"row ${i}"}`).join('\n'))
  // One line longer than a 64 KiB piece, for the continuation (spec §3.4, Z37).
  const long = join(tmpdir(), 'spike-long-line.txt')
  writeFileSync(long, `${'x'.repeat(65_536)}${'y'.repeat(100)}\nshort\n`)
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await expect(win.locator('#status')).toHaveText('core 0.0.0')
  const result = await win.evaluate(async ([p, l]) => {
    const core = (window as any).__spike.core
    const { doc } = await core.call('open', { path: p })
    const done = await new Promise<any>((ok) => core.onEvent((e: any) => e.doc === doc && e.done && ok(e)))
    const rows = await core.call('rows', { doc, start: 4998, count: 10 })
    // A piece is fetched by its byte offset: it reads the file, not the index, so it needs no progress event.
    const { doc: longDoc } = await core.call('open', { path: l })
    const first = await core.call('piece', { doc: longDoc, line: 0, offset: 0 })
    const next = await core.call('piece', { doc: longDoc, line: 0, offset: first.offset + 65_536 })
    return { lines: done.lines, rows, first: [first.text.length, first.more], next }
  }, [path, long])
  expect(result.lines).toBe(5000)
  expect(result.rows.map((r: any) => r.summary)).toEqual(['row 4998', 'row 4999'])
  expect(result.first).toEqual([65_536, true])
  expect(result.next).toEqual({ line: 0, offset: 65_536, text: 'y'.repeat(100), more: false })
  await app.close()
})
```
Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e open`.
Expected: FAIL with `unknown method open`.

- [ ] **Step 2: Implement the addon class**

Replace `spikes/core/spike-node/src/lib.rs`:
```rust
use std::fs::File;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use spike_core::index::{build, IndexConfig, LineIndex};
use spike_core::pages;
use spike_core::store::ByteStore;

/// Progress is throttled to 10 Hz, except while a first screen of lines is still filling (spec §3.4).
const FIRST_SCREEN_LINES: u64 = 256;

#[napi]
pub fn core_version() -> String {
    spike_core::version().to_string()
}

#[napi(object)]
pub struct IndexProgress {
    pub lines: i64,
    pub bytes: i64,
    pub done: bool,
    pub elapsed_ms: i64,
    pub error: Option<String>,
}

#[napi(object)]
pub struct JsLine {
    pub line: i64,
    pub offset: i64,
    pub text: String,
    pub more: bool,
}

#[napi(object)]
pub struct JsRow {
    pub line: i64,
    pub ts: Option<String>,
    pub kind: Option<String>,
    pub summary: String,
    pub more: bool,
    pub bad: bool,
}

#[napi]
pub struct Doc {
    path: String,
    store: Arc<ByteStore>,
    index: Arc<RwLock<LineIndex>>,
}

fn err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

#[napi]
impl Doc {
    #[napi(factory)]
    pub fn open(path: String) -> Result<Doc> {
        let store = ByteStore::open(Path::new(&path)).map_err(err)?;
        Ok(Doc { path, store: Arc::new(store), index: Arc::new(RwLock::new(LineIndex::default())) })
    }

    #[napi(getter)]
    pub fn size(&self) -> i64 {
        self.store.len() as i64
    }

    /// Indexes on a background thread with its own file handle, so page reads never queue behind index reads.
    #[napi]
    pub fn start_index(&self, on_progress: ThreadsafeFunction<IndexProgress, (), IndexProgress, Status, false>) -> Result<()> {
        let (len, hashes, index) = (self.store.len(), self.store.hashes(), self.index.clone());
        let file = File::open(&self.path).map_err(err)?;
        std::thread::spawn(move || {
            let mut last: Option<Instant> = None;
            let mut sent_lines = 0u64;
            let result = build(&file, len, IndexConfig::default(), &hashes, &index, |p| {
                let filling_first_screen = sent_lines < FIRST_SCREEN_LINES && p.lines > sent_lines;
                if p.done || filling_first_screen || last.is_none_or(|t| t.elapsed() >= Duration::from_millis(100)) {
                    last = Some(Instant::now());
                    sent_lines = p.lines;
                    let progress = IndexProgress {
                        lines: p.lines as i64,
                        bytes: p.bytes as i64,
                        done: p.done,
                        elapsed_ms: p.elapsed_ms as i64,
                        error: None,
                    };
                    on_progress.call(progress, ThreadsafeFunctionCallMode::NonBlocking);
                }
            });
            if let Err(e) = result {
                let progress = IndexProgress { lines: sent_lines as i64, bytes: 0, done: false, elapsed_ms: 0, error: Some(e.to_string()) };
                on_progress.call(progress, ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
        Ok(())
    }

    #[napi]
    pub fn lines(&self, start: i64, count: u32) -> Result<Vec<JsLine>> {
        let index = self.index.read().unwrap();
        let got = pages::lines(&self.store, &index, start.max(0) as u64, count).map_err(err)?;
        Ok(got
            .into_iter()
            .map(|p| JsLine { line: p.line as i64, offset: p.offset as i64, text: p.text, more: p.more })
            .collect())
    }

    /// Spec §3.4's continuation (Z37): the bounded piece of `line` at byte `offset`; a `more` piece continues at
    /// its offset + 65,536. It reads the file, not the index, so it works while indexing proceeds.
    #[napi]
    pub fn piece(&self, line: i64, offset: i64) -> Result<JsLine> {
        let p = pages::piece(&self.store, line.max(0) as u64, offset.max(0) as u64).map_err(err)?;
        Ok(JsLine { line: p.line as i64, offset: p.offset as i64, text: p.text, more: p.more })
    }

    #[napi]
    pub fn rows(&self, start: i64, count: u32) -> Result<Vec<JsRow>> {
        let index = self.index.read().unwrap();
        let got = pages::rows(&self.store, &index, start.max(0) as u64, count).map_err(err)?;
        Ok(got
            .into_iter()
            .map(|r| JsRow { line: r.line as i64, ts: r.ts, kind: r.kind, summary: r.summary, more: r.more, bad: r.bad })
            .collect())
    }
}
```

- [ ] **Step 3: Implement the core-host RPC**

Replace `spikes/app/src/main/core-host.ts`:
```ts
import type { MessagePortMain } from 'electron'
import { Doc, coreVersion } from 'spike-node'

type Handler = (params: any) => unknown

function serve(port: MessagePortMain): void {
  const docs = new Map<number, Doc>()
  let nextDoc = 1
  const get = (id: number): Doc => {
    const doc = docs.get(id)
    if (!doc) throw new Error(`no document ${id}`)
    return doc
  }
  const handlers: Record<string, Handler> = {
    version: () => coreVersion(),
    open: ({ path }: { path: string }) => {
      const doc = Doc.open(path)
      const id = nextDoc++
      docs.set(id, doc)
      doc.startIndex((p) => port.postMessage({ event: 'progress', doc: id, ...p }))
      return { doc: id, size: doc.size }
    },
    lines: ({ doc, start, count }: { doc: number; start: number; count: number }) => get(doc).lines(start, count),
    piece: ({ doc, line, offset }: { doc: number; line: number; offset: number }) => get(doc).piece(line, offset),
    rows: ({ doc, start, count }: { doc: number; start: number; count: number }) => get(doc).rows(start, count),
    close: ({ doc }: { doc: number }) => docs.delete(doc)
  }
  port.on('message', ({ data }) => {
    const { id, method, params } = data as { id: number; method: string; params: unknown }
    try {
      const handler = handlers[method]
      if (!handler) throw new Error(`unknown method ${method}`)
      port.postMessage({ id, result: handler(params) })
    } catch (err) {
      port.postMessage({ id, error: String(err) })
    }
  })
  port.start()
}

process.parentPort.once('message', (e) => serve(e.ports[0]))
```

- [ ] **Step 4: Rebuild and run the test until it passes**

Run (`spikes/core/spike-node`): `npm run build`.
Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e open`.
Expected: `1 passed`.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-node/src spikes/app/src/main/core-host.ts spikes/app/e2e/open.e2e.ts
git commit -m "spike(a): napi Doc with background indexing and core-host RPC"
```

---

## Task 8: Shell hardening — typose:// with code cache, network guard, no proxy, NetLog, Windows title bar

**Files:**
- Modify: `spikes/app/src/main/index.ts` (full replacement below)
- Modify: `spikes/app/src/renderer/index.html` (full replacement below)
- Create: `spikes/app/src/renderer/src/style.css`
- Create: `spikes/app/e2e/shell.e2e.ts`

**Interfaces:**
- **Produces:**
  - **Environment switches read by main:**
    - `TYPOSE_OPEN=<path>` and `TYPOSE_LENS=raw|rows` are appended to the URL as `?open=&lens=`;
    - `TYPOSE_NETLOG=<file>` turns on `--log-net-log`;
    - `TYPOSE_NO_CODECACHE=1` registers the scheme without `codeCache`, for the A/B measurement;
    - `TYPOSE_SHOWN_FILE=<file>` writes `Date.now()` on `ready-to-show`, then quits (used by `perf/shell-visible.mjs`).
  - **Renderer:** loads from `typose://app/index.html`.
  - **Allowed request schemes:** `typose`, `data`, `blob`, plus `devtools` when `!app.isPackaged`.

**Design notes:**
- **The shell e2e pins the session guard itself.** The page CSP already blocks a renderer `fetch` to the web. So the test also has main `net.fetch` a loopback address on an unsafe port. With the guard in place that fails `ERR_BLOCKED_BY_CLIENT`; without it, `ERR_UNSAFE_PORT`. No traffic leaves the machine either way.
- **The `typose://` handler reads files with `fs`, not `net.fetch(file:)`.** `net.fetch` goes through the default session, so the app's own `onBeforeRequest` guard cancels it (`ERR_BLOCKED_BY_CLIENT`).
- **`--no-proxy-server` is required for the NetLog gate.**
  - With Windows' "Automatically detect settings" on, Chromium runs WPAD at startup: DHCP, then a DNS lookup for `wpad`. It does this in every network context, with no request involved.
  - `session.setProxy({ mode: 'direct' })` only halves it (60 → 32 violations); the global switch removes it.
  - This is a spec finding for REPORT-A. The switch also bypasses the system proxy for spec §7.3's user-clicked remote images, which the checkpoint must decide on.

- [ ] **Step 1: Write the failing e2e test**

`spikes/app/e2e/shell.e2e.ts`:
```ts
import { _electron as electron, expect, test } from '@playwright/test'

test('the app runs from typose:// and cannot reach the network', async () => {
  const app = await electron.launch({ args: ['.'] })
  const win = await app.firstWindow()
  await expect(win.locator('#status')).toHaveText('core 0.0.0')
  expect(await win.evaluate(() => location.protocol)).toBe('typose:')
  const outcome = await win.evaluate(() =>
    fetch('https://example.com/').then(
      () => 'reached',
      () => 'blocked'
    )
  )
  expect(outcome).toBe('blocked')
  // The page CSP alone blocks the renderer fetch above; this pins the session guard itself (loopback, unsafe port: no traffic).
  const viaMain = await app.evaluate(({ net }) => net.fetch('http://127.0.0.1:9/').then(() => 'reached', (e: Error) => String(e)))
  expect(viaMain).toContain('ERR_BLOCKED_BY_CLIENT')
  await app.close()
})
```
Run (`spikes/app`): `npm run build`, then `npx playwright test --project=e2e shell`.
Expected: FAIL. The protocol is `file:`.

- [ ] **Step 2: Implement main**

Replace `spikes/app/src/main/index.ts`:
```ts
import { app, BrowserWindow, MessageChannelMain, protocol, session, utilityProcess } from 'electron'
import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import coreHostPath from './core-host?modulePath'

// No proxy resolution at all: with Windows' "Automatically detect settings" on, Chromium otherwise runs WPAD
// (a DNS lookup for "wpad") at startup in every network context, though Typose requests nothing (spec §7.3).
app.commandLine.appendSwitch('no-proxy-server')
if (process.env.TYPOSE_NETLOG) app.commandLine.appendSwitch('log-net-log', process.env.TYPOSE_NETLOG)

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'typose',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      codeCache: !process.env.TYPOSE_NO_CODECACHE
    }
  }
])

const ALLOWED = app.isPackaged ? /^(typose|data|blob):/ : /^(typose|data|blob|devtools):/
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

function createWindow(): void {
  const rendererDir = join(__dirname, '../renderer')
  // Read with fs, not net.fetch: net.fetch(file:) would itself be cancelled by the network guard below.
  protocol.handle('typose', async (req) => {
    const file = join(rendererDir, decodeURIComponent(new URL(req.url).pathname))
    if (!file.startsWith(rendererDir + sep)) return new Response('bad path', { status: 400 })
    try {
      const body = await readFile(file)
      return new Response(body, { headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !ALLOWED.test(details.url) })
  })

  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#111113',
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#111113', symbolColor: '#EDEDED', height: 40 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const core = utilityProcess.fork(coreHostPath, [], { serviceName: 'typose-core' })
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage({ type: 'port' }, [port1])
  win.webContents.once('did-finish-load', () => win.webContents.postMessage('core-port', null, [port2]))
  win.once('ready-to-show', () => {
    win.show()
    // Shell-visible timing for perf/shell-visible.mjs: record the wall clock, then quit.
    if (process.env.TYPOSE_SHOWN_FILE) {
      writeFileSync(process.env.TYPOSE_SHOWN_FILE, String(Date.now()))
      app.quit()
    }
  })

  const url = new URL('typose://app/index.html')
  if (process.env.TYPOSE_OPEN) {
    url.searchParams.set('open', process.env.TYPOSE_OPEN)
    url.searchParams.set('lens', process.env.TYPOSE_LENS ?? 'raw')
  }
  void win.loadURL(url.toString())
}

void app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
```

- [ ] **Step 3: Implement the title bar markup and styles**

Replace `spikes/app/src/renderer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:" />
    <title>Typose spike</title>
    <link rel="stylesheet" href="./src/style.css" />
  </head>
  <body>
    <header id="titlebar"><span id="status">connecting…</span></header>
    <main id="card"></main>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
```
`spikes/app/src/renderer/src/style.css`:
```css
:root {
  color-scheme: dark;
  --canvas: #111113;
  --surface: #1b1b1d;
  --text: #ededed;
  --text2: #8a8a8f;
  --warn: #f5a35c;
}
html, body { margin: 0; height: 100%; background: var(--canvas); color: var(--text); font: 13px/1.4 system-ui, sans-serif; }
#titlebar { height: 40px; display: flex; align-items: center; padding: 0 12px; -webkit-app-region: drag; }
#card { position: absolute; inset: 40px 8px 8px; background: var(--surface); border-radius: 12px; overflow: hidden; }
.vl-scroller { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; outline: none; overflow-anchor: none; }
.vl-layer { position: sticky; top: 0; overflow: hidden; }
.vl-row { position: absolute; left: 0; right: 0; white-space: pre; overflow: hidden; text-overflow: ellipsis; font: 13px/24px ui-monospace, monospace; padding: 0 12px; }
.vl-row .gutter { color: var(--text2); display: inline-block; min-width: 9ch; text-align: right; margin-right: 12px; }
.vl-row.bad { color: var(--warn); }
.vl-row .pill { display: inline-block; padding: 0 6px; margin-right: 8px; border-radius: 6px; background: #1e2a4a; color: #a9c1ff; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (`spikes/app`): `npm run build`, then `npm run e2e`.
Expected: `3 passed` (roundtrip, open, shell).

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src spikes/app/e2e/shell.e2e.ts
git commit -m "spike(a): typose:// with code cache, network guard, no proxy, NetLog switch, WCO title bar"
```

---

## Task 9: Logical scrolling, the virtualizer, Raw/Rows lenses and perf hooks

**Files:**
- Create: `spikes/app/src/renderer/src/scrollmath.ts`, `spikes/app/src/renderer/src/scrollmath.test.ts`
- Create: `spikes/app/src/renderer/src/virtual-list.ts`, `spikes/app/src/renderer/src/lens-view.ts`
- Modify: `spikes/app/src/renderer/src/main.ts` (full replacement below)

**Interfaces:**
- **Consumes:**
  - `Core` from `core.ts`;
  - `PerfLog` from `perf.ts`;
  - the RPC methods `open`, `lines`, `rows`;
  - the `progress` event.
- **Produces:**
  - **scrollmath.ts:**
    - `SPACER_CAP = 16_000_000`;
    - `ScrollGeometry { total, viewport }`;
    - `spacerHeight(total)`, `isLogical(total)`, `toNative(top, g)`, `toLogical(native, g)`;
    - `wheelPixels(deltaY, deltaMode, rowHeight, viewport)`;
    - `clampTop(top, g)`;
    - `visibleRows(top, viewport, rowHeight, rowCount, overscan): { first, last }` (`last` is exclusive);
    - `class ScrollState`:
      - `top`, `geometry`;
      - `setTotal(total)`, `setViewport(px)`;
      - `moveBy(px): number` and `moveTo(px): number`, which return the native scrollTop to apply;
      - `confirmNative(applied)`;
      - `onNativeScroll(nativeTop): boolean`, which returns `true` when it was a user jump.
  - **virtual-list.ts:** `class VirtualList`:
    - `constructor(parent, rowHeight, paint, onRange)`;
    - `setRowCount(n)` (in logical mode it re-applies the logical position, so the thumb tracks a growing total), `refresh()`;
    - `scrollToRow(i)`, `pageDown()`;
    - `visibleRange(): { first, last }` (the mounted range, overscan included), `firstVisibleRow()`;
    - `readonly state: ScrollState`.
    - Keys: arrows, PageUp/PageDown, Home/End and Space/Shift+Space all move 1:1. A key it doesn't handle would fall through to Chromium's native scroll, which is a proportional jump in logical mode.
  - **lens-view.ts:** `class LensView`:
    - `constructor(parent, core, doc, kind: 'raw' | 'rows', perf)`;
    - `setRowCount(n, done)`;
    - `readonly list`.
    - It marks `firstScreen` once its first page has painted: the rows available at that moment, up to a viewport. It waits for neither more rows nor the index, so on a file whose first line is huge, the first screen is that line's first piece (Z37).
  - **`window.__spike`:** `{ core, perf, open(path, kind), doc?, view?, indexDone? }`. `open` exists only after the `version` round trip, so harnesses wait for `__spike.open`.
  - **Perf marks:** `openStart`, `firstScreen` (the lens), `fullLineScan` (the first progress event past line 0's end, `lines > 1` or done: Z37's full-line scan completion, timed apart from the first screen) and `indexDone`. `fullLineScan` can land up to one 4 MiB block late when line 0 ends exactly at a block boundary.
  - **Input latency:** `keydown` and `wheel`, from the event's OS timestamp until after the next frame has painted (rAF, then a task).
  - **F9:** toggles a frame sampler. The result shows in `#status`, including the largest per-frame scroll step.

**Design note:**
- Chromium quantizes large scroll offsets: near 10M px, `scrollTop` moves in 2px steps.
- So an echo of the virtualizer's own scrollbar update can land more than 1px from the requested value. Comparing against the requested value made every other echo look like a user jump, and drifted deep reading by 2 rows per 10 notches.
- The fix: the virtualizer reads `scrollTop` back after setting it, and matches echoes against that value (`confirmNative`).

- [ ] **Step 1: Write the failing ScrollState tests**

`spikes/app/src/renderer/src/scrollmath.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { SPACER_CAP, ScrollState, toLogical, toNative, visibleRows, wheelPixels } from './scrollmath'

const ROW = 24
const VIEWPORT = 800

describe('native mode (content within the spacer cap)', () => {
  it('maps 1:1 and ignores its own scroll echo', () => {
    const s = new ScrollState({ total: 100_000 * ROW, viewport: VIEWPORT })
    expect(s.moveBy(100)).toBe(100)
    expect(s.onNativeScroll(100)).toBe(false)
    expect(s.onNativeScroll(500)).toBe(true)
    expect(s.top).toBe(500)
  })
})

describe('logical mode (50M rows × 24px = 1.2e9 px over a 16M px spacer)', () => {
  const total = 50_000_000 * ROW

  it('moves a wheel notch the same distance deep in the file as at the top (Astra R3)', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    const notches = (start: number) => {
      s.moveTo(start)
      for (let i = 0; i < 10; i++) s.moveBy(wheelPixels(120, 0, ROW, VIEWPORT))
      return s.top - start
    }
    expect(notches(0)).toBe(1200)
    expect(notches(40_000_000 * ROW)).toBe(1200)
  })

  it('pages exactly one viewport', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    s.moveTo(40_000_000 * ROW)
    const before = s.top
    s.moveBy(VIEWPORT)
    expect(s.top - before).toBe(VIEWPORT)
  })

  it('treats an unexpected native scroll as a coarse proportional jump', () => {
    const g = { total, viewport: VIEWPORT }
    const s = new ScrollState(g)
    const native = (SPACER_CAP - VIEWPORT) / 2
    expect(s.onNativeScroll(native)).toBe(true)
    expect(s.top).toBeCloseTo((total - VIEWPORT) / 2, -1)
    expect(toNative(toLogical(native, g), g)).toBeCloseTo(native, 6)
  })

  it('ignores the echo of its own scrollbar update', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    const native = s.moveBy(1200)
    expect(s.onNativeScroll(native + 0.4)).toBe(false)
    expect(s.top).toBe(1200)
  })

  it('matches the echo against the offset the browser actually applied', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    s.moveTo(40_000_000 * ROW)
    const target = s.moveBy(120)
    s.confirmNative(Math.round(target / 2) * 2 + 2) // a 2px-quantized offset more than 1px from the target
    expect(s.onNativeScroll(Math.round(target / 2) * 2 + 2)).toBe(false)
    expect(s.top).toBe(40_000_000 * ROW + 120)
  })

  it('reaches the true last row', () => {
    const s = new ScrollState({ total, viewport: VIEWPORT })
    s.moveTo(Number.MAX_SAFE_INTEGER)
    expect(s.top).toBe(total - VIEWPORT)
    expect(visibleRows(s.top, VIEWPORT, ROW, 50_000_000, 0).last).toBe(50_000_000)
  })
})

describe('wheelPixels', () => {
  it('converts line and page deltas', () => {
    expect(wheelPixels(3, 1, ROW, VIEWPORT)).toBe(72)
    expect(wheelPixels(1, 2, ROW, VIEWPORT)).toBe(VIEWPORT)
  })
})
```
Run (`spikes/app`): `npx vitest run src/renderer/src/scrollmath.test.ts`
Expected: FAIL, because it can't resolve `./scrollmath`.

- [ ] **Step 2: Implement scrollmath.ts**

`spikes/app/src/renderer/src/scrollmath.ts`:
```ts
// Native scrolling below the cap, logical above it (spec §5.3).
export const SPACER_CAP = 16_000_000

export interface ScrollGeometry {
  total: number
  viewport: number
}

export const spacerHeight = (total: number): number => Math.min(total, SPACER_CAP)
export const isLogical = (total: number): boolean => total > SPACER_CAP

const ranges = (g: ScrollGeometry): [number, number] => [
  Math.max(1, g.total - g.viewport),
  Math.max(1, SPACER_CAP - g.viewport)
]

export function toNative(top: number, g: ScrollGeometry): number {
  if (!isLogical(g.total)) return top
  const [logical, native] = ranges(g)
  return (top / logical) * native
}

export function toLogical(nativeTop: number, g: ScrollGeometry): number {
  if (!isLogical(g.total)) return nativeTop
  const [logical, native] = ranges(g)
  return (nativeTop / native) * logical
}

export function wheelPixels(deltaY: number, deltaMode: number, rowHeight: number, viewport: number): number {
  if (deltaMode === 1) return deltaY * rowHeight
  if (deltaMode === 2) return deltaY * viewport
  return deltaY
}

export const clampTop = (top: number, g: ScrollGeometry): number =>
  Math.min(Math.max(0, top), Math.max(0, g.total - g.viewport))

export function visibleRows(top: number, viewport: number, rowHeight: number, rowCount: number, overscan: number) {
  return {
    first: Math.max(0, Math.floor(top / rowHeight) - overscan),
    last: Math.min(rowCount, Math.ceil((top + viewport) / rowHeight) + overscan)
  }
}

export class ScrollState {
  top = 0
  private expected: number | null = null

  constructor(private g: ScrollGeometry) {}

  get geometry(): ScrollGeometry {
    return this.g
  }

  setTotal(total: number): void {
    this.g = { ...this.g, total }
    this.top = clampTop(this.top, this.g)
  }

  setViewport(viewport: number): void {
    this.g = { ...this.g, viewport }
    this.top = clampTop(this.top, this.g)
  }

  /** Wheel, trackpad and keys: 1:1 in logical pixels. Returns the native scrollTop to apply. */
  moveBy(px: number): number {
    return this.moveTo(this.top + px)
  }

  moveTo(px: number): number {
    this.top = clampTop(px, this.g)
    this.expected = toNative(this.top, this.g)
    return this.expected
  }

  /** The browser quantizes large scroll offsets (2px steps near 10M px), so the caller reports what it actually applied. */
  confirmNative(applied: number): void {
    this.expected = applied
  }

  /** Our own scrollbar updates echo back and are ignored; anything else is a user jump. */
  onNativeScroll(nativeTop: number): boolean {
    if (this.expected !== null && Math.abs(nativeTop - this.expected) < 1) {
      this.expected = null
      return false
    }
    this.expected = null
    this.top = clampTop(toLogical(nativeTop, this.g), this.g)
    return true
  }
}
```
Run: `npx vitest run src/renderer/src/scrollmath.test.ts`
Expected: `8 passed`.

- [ ] **Step 3: Implement the virtualizer and the lenses**

`spikes/app/src/renderer/src/virtual-list.ts`:
```ts
import { ScrollState, isLogical, spacerHeight, visibleRows, wheelPixels } from './scrollmath'

export class VirtualList {
  readonly state: ScrollState
  private readonly scroller: HTMLDivElement
  private readonly layer: HTMLDivElement
  private readonly spacer: HTMLDivElement
  private readonly rows = new Map<number, HTMLDivElement>()
  private rowCount = 0
  private applied = 0
  private pointerDown = false

  constructor(
    parent: HTMLElement,
    private readonly rowHeight: number,
    private readonly paint: (i: number, el: HTMLDivElement) => void,
    private readonly onRange: (r: { first: number; last: number }) => void
  ) {
    this.scroller = Object.assign(document.createElement('div'), { className: 'vl-scroller', tabIndex: 0 })
    this.layer = Object.assign(document.createElement('div'), { className: 'vl-layer' })
    this.spacer = document.createElement('div')
    this.scroller.append(this.layer, this.spacer)
    parent.append(this.scroller)
    this.state = new ScrollState({ total: 0, viewport: parent.clientHeight })
    this.resize()
    new ResizeObserver(() => this.resize()).observe(parent)
    this.scroller.addEventListener(
      'wheel',
      (e) => {
        if (!isLogical(this.state.geometry.total)) return
        e.preventDefault()
        this.apply(this.state.moveBy(wheelPixels(e.deltaY, e.deltaMode, this.rowHeight, this.state.geometry.viewport)))
      },
      { passive: false }
    )
    this.scroller.addEventListener('scroll', () => {
      this.applied = this.scroller.scrollTop
      if (this.state.onNativeScroll(this.scroller.scrollTop)) this.render()
    })
    this.scroller.addEventListener('keydown', (e) => this.key(e))
    this.scroller.addEventListener('pointerdown', () => (this.pointerDown = true))
    window.addEventListener('pointerup', () => (this.pointerDown = false))
  }

  setRowCount(n: number): void {
    // A user scroll not yet dispatched: read it under the mapping it was made in, before the total changes.
    if (isLogical(this.state.geometry.total) && Math.abs(this.scroller.scrollTop - this.applied) >= 1) this.state.onNativeScroll(this.scroller.scrollTop)
    this.rowCount = n
    this.state.setTotal(n * this.rowHeight)
    this.layoutSpacer()
    // In logical mode the thumb maps proportionally, so a growing total moves it: re-apply the same logical position,
    // except during a thumb drag, which keeps the thumb under the cursor.
    if (isLogical(this.state.geometry.total) && !this.pointerDown) this.apply(this.state.moveTo(this.state.top))
    else this.render()
  }

  refresh(): void {
    for (const [i, el] of this.rows) this.paint(i, el)
  }

  scrollToRow(i: number): void {
    this.apply(this.state.moveTo(i * this.rowHeight))
  }

  pageDown(): void {
    this.apply(this.state.moveBy(this.state.geometry.viewport))
  }

  /** The mounted row range, overscan included. */
  visibleRange(): { first: number; last: number } {
    return visibleRows(this.state.top, this.state.geometry.viewport, this.rowHeight, this.rowCount, 10)
  }

  firstVisibleRow(): number {
    return Math.floor(this.state.top / this.rowHeight)
  }

  private key(e: KeyboardEvent): void {
    const vp = this.state.geometry.viewport
    const moves: Record<string, () => number> = {
      ArrowDown: () => this.state.moveBy(this.rowHeight),
      ArrowUp: () => this.state.moveBy(-this.rowHeight),
      PageDown: () => this.state.moveBy(vp),
      PageUp: () => this.state.moveBy(-vp),
      Home: () => this.state.moveTo(0),
      End: () => this.state.moveTo(Number.MAX_SAFE_INTEGER),
      ' ': () => this.state.moveBy(e.shiftKey ? -vp : vp)
    }
    const move = moves[e.key]
    if (!move) return
    e.preventDefault()
    this.apply(move())
  }

  private apply(native: number): void {
    this.scroller.scrollTop = native
    this.applied = this.scroller.scrollTop
    this.state.confirmNative(this.applied)
    this.render()
  }

  private resize(): void {
    const vp = this.scroller.clientHeight
    this.layer.style.height = `${vp}px`
    this.state.setViewport(vp)
    this.layoutSpacer()
    this.render()
  }

  private layoutSpacer(): void {
    // The sticky layer takes one viewport of scroll height; the spacer supplies the rest.
    const vp = this.state.geometry.viewport
    this.spacer.style.height = `${Math.max(0, spacerHeight(this.state.geometry.total) - vp)}px`
  }

  private render(): void {
    const range = this.visibleRange()
    for (const [i, el] of this.rows) {
      if (i < range.first || i >= range.last) {
        el.remove()
        this.rows.delete(i)
      }
    }
    for (let i = range.first; i < range.last; i++) {
      let el = this.rows.get(i)
      if (!el) {
        el = Object.assign(document.createElement('div'), { className: 'vl-row' })
        this.layer.append(el)
        this.rows.set(i, el)
        this.paint(i, el)
      }
      el.style.transform = `translateY(${i * this.rowHeight - this.state.top}px)`
    }
    this.onRange(range)
  }
}
```
`spikes/app/src/renderer/src/lens-view.ts`:
```ts
import type { Core } from './core'
import type { PerfLog } from './perf'
import { VirtualList } from './virtual-list'

interface Line {
  line: number
  text: string
  more: boolean
}
interface Row {
  line: number
  ts?: string
  kind?: string
  summary: string
  more: boolean
  bad: boolean
}
type Item = Line | Row

const ROW_HEIGHT = 24
const KEEP = 4000

export class LensView {
  readonly list: VirtualList
  private readonly cache = new Map<number, Item>()
  private wanted: { first: number; last: number } | null = null
  private inflight = 0
  private scheduled = false
  private firstScreenDone = false
  private done = false

  constructor(
    parent: HTMLElement,
    private readonly core: Core,
    private readonly doc: number,
    private readonly kind: 'raw' | 'rows',
    private readonly perf: PerfLog
  ) {
    this.list = new VirtualList(parent, ROW_HEIGHT, (i, el) => this.paint(i, el), (r) => this.want(r))
  }

  setRowCount(n: number, done: boolean): void {
    this.done = done
    this.list.setRowCount(n)
  }

  /** Coalesces viewport requests to one per animation frame (spec §3.4). */
  private want(r: { first: number; last: number }): void {
    this.wanted = r
    if (this.scheduled) return
    this.scheduled = true
    requestAnimationFrame(() => {
      this.scheduled = false
      this.pump()
    })
  }

  /** At most 2 requests in flight (spec §3.4). */
  private pump(): void {
    const r = this.wanted
    if (!r || this.inflight >= 2) return
    let start = r.first
    while (start < r.last && this.cache.has(start)) start++
    if (start >= r.last) {
      this.markFirstScreen(r)
      return
    }
    this.wanted = null
    this.inflight++
    const t0 = performance.now()
    void this.core
      .call<Item[]>(this.kind === 'raw' ? 'lines' : 'rows', { doc: this.doc, start, count: r.last - start })
      .then(
        (items) => {
          this.perf.fetch(performance.now() - t0)
          for (const it of items) this.cache.set(it.line, it)
          this.evict(this.list.visibleRange()) // around the current viewport, not the (possibly stale) request
          this.list.refresh()
          // A page stops at 256 KiB, so the range can still have gaps: keep pumping it unless a newer range is wanted.
          if (items.length > 0) this.wanted ??= r
        },
        (err: unknown) => console.error('page fetch failed', err)
      )
      .finally(() => {
        this.inflight--
        this.pump()
      })
  }

  private evict(r: { first: number; last: number }): void {
    if (this.cache.size <= KEEP) return
    for (const line of this.cache.keys()) if (line < r.first - KEEP / 2 || line > r.last + KEEP / 2) this.cache.delete(line)
  }

  /** First screen = the first page painted: the rows available now, up to a viewport. It waits for neither more rows
   *  nor the index, so on a huge first line it's that line's first piece (Z37). `r` is the mounted range, all cached. */
  private markFirstScreen(r: { first: number; last: number }): void {
    if (this.firstScreenDone || (r.last === r.first && !this.done)) return
    this.firstScreenDone = true
    // rAF then a task: the mark lands after the frame that shows the rows has painted.
    requestAnimationFrame(() => setTimeout(() => this.perf.mark('firstScreen')))
  }

  private paint(i: number, el: HTMLDivElement): void {
    const item = this.cache.get(i)
    el.replaceChildren()
    el.className = 'vl-row'
    el.append(Object.assign(document.createElement('span'), { className: 'gutter', textContent: String(i + 1) }))
    if (!item) return
    if (!('summary' in item)) {
      el.append(item.text + (item.more ? ' …' : ''))
      return
    }
    if (item.bad) el.classList.add('bad')
    if (item.ts) el.append(`${item.ts}  `)
    if (item.kind) el.append(Object.assign(document.createElement('span'), { className: 'pill', textContent: item.kind }))
    el.append(item.summary + (item.more ? ' …' : ''))
  }
}
```
Replace `spikes/app/src/renderer/src/main.ts`:
```ts
import { connectCore } from './core'
import { LensView } from './lens-view'
import { PerfLog } from './perf'

const perf = new PerfLog()
const spike: Record<string, unknown> = { perf }
;(window as any).__spike = spike

const core = await connectCore()
spike.core = core
const status = document.getElementById('status')!
status.textContent = `core ${await core.call<string>('version')}`

// Input latency: from the OS event timestamp until the frame that follows it has painted (rAF, then a task).
for (const type of ['keydown', 'wheel'] as const) {
  window.addEventListener(
    type,
    (e) => requestAnimationFrame(() => setTimeout(() => perf.inputLatency.push(performance.now() - e.timeStamp))),
    { capture: true, passive: true }
  )
}

/** Opens a file into the card. The perf runner calls this once the shell is up; ?open= calls it at launch. */
async function open(path: string, kind: 'raw' | 'rows'): Promise<void> {
  perf.mark('openStart')
  const { doc } = await core.call<{ doc: number }>('open', { path })
  spike.doc = doc
  const view = new LensView(document.getElementById('card')!, core, doc, kind, perf)
  spike.view = view
  core.onEvent((e) => {
    if (e.event !== 'progress' || e.doc !== doc) return
    if (e.error) status.textContent = `indexing stopped: ${e.error}`
    view.setRowCount(e.lines as number, e.done as boolean)
    // Full-line scan completion, measured apart from the first screen (Z37): the first event past line 0's end.
    if (perf.marks.fullLineScan === undefined && ((e.lines as number) > 1 || e.done)) perf.mark('fullLineScan')
    if (e.done) {
      spike.indexDone = e
      perf.mark('indexDone')
    }
  })
}
spike.open = open

const params = new URLSearchParams(location.search)
const path = params.get('open')
if (path) void open(path, params.get('lens') === 'rows' ? 'rows' : 'raw')

// F9 toggles a frame sampler that also records the largest per-frame scroll step (the Mac trackpad gate).
let sampling = false
window.addEventListener('keydown', (e) => {
  const view = spike.view as LensView | undefined
  if (e.key !== 'F9' || !view) return
  sampling = !sampling
  if (sampling) {
    perf.startFrames(() => view.list.state.top)
    status.textContent = 'sampling frames… F9 to stop'
    return
  }
  const s = perf.stopFrames()
  const vp = view.list.state.geometry.viewport
  status.textContent = `frames ${s.frames} · long ${(s.longShare * 100).toFixed(2)}% · stalls ${s.stalls} · max step ${Math.round(s.maxStep)}px (viewport ${vp}px)`
})
```

- [ ] **Step 4: Run all unit and e2e tests, then a manual smoke test**

Run (`spikes/app`): `npm test`
Expected: `Tests 11 passed` (3 perf + 8 scrollmath).

Run: `npm run build`, then `npm run e2e`.
Expected: `3 passed`.

Launch with `TYPOSE_OPEN` set to the full path of `spikes/.fixtures/10g.jsonl`. The PowerShell form clears the variable afterwards; a leftover `TYPOSE_OPEN` would make every later launch open the file too.
- PowerShell: `$env:TYPOSE_OPEN="$PWD\..\.fixtures\10g.jsonl"; npx electron .; Remove-Item Env:TYPOSE_OPEN`
- Git Bash: `TYPOSE_OPEN="$(cygpath -w "$PWD/../.fixtures/10g.jsonl")" npx electron .`

Expected (click into the list first, so keys reach it):
- lines appear at once, and the scrollbar grows while indexing;
- the wheel, PageDown, Space and End keys work;
- F9, a flick-scroll, then F9 again shows the frame summary in the title bar.

Close the window.

- [ ] **Step 5: Read your own work (rule 8), then commit**

```bash
git add spikes/app/src/renderer/src
git commit -m "spike(a): logical scrolling virtualizer with Raw/Rows lenses and perf hooks"
```

---

## Task 10: The Spike A perf runner and the shell-visible timer

**Files:**
- Create: `spikes/app/perf/spike-a.e2e.ts`, `spikes/app/perf/shell-visible.mjs`
- Create: `spikes/results/.gitkeep`

**Interfaces:**
- **Consumes:**
  - `window.__spike`: `open`, `perf` (`marks`, `fetches`, `inputLatency`, `startFrames`, `stopFrames`), `view.list` (`scrollToRow`, `pageDown`, `firstVisibleRow`, `state`), `doc`, `indexDone`, `core` (with Task 7's `piece` RPC).
  - The main environment switches from Task 8.
- **Produces:** `spikes/results/spike-a-<hostname>.json`, keyed by gate:
  - Timing keys hold `{ n, p50, p95, max, samples }`.
  - `indexDoneAtFirstScreen:<file>:<lens>` counts the samples where indexing had already finished when the first screen painted: the `indexDone` perf mark (Task 9's `main.ts`) is no later than the `firstScreen` mark. The spec's "without scanning to end of file" needs 0 for the 1 and 10 GiB files. Under Z37, `one-line.jsonl` needs 0 too: its 1 GiB line takes about 250 ms to scan on the PC, so a lens that waits for the line's end can't pass. `huge-first.jsonl` is judged only on a machine whose `fullLineScan` p50 exceeds its first-screen budget; otherwise the scan can finish inside the paint.
  - For the files whose first line is huge (`huge-first.jsonl`, and `one-line.jsonl`, 1 GiB on a single line), `fullLineScan:<file>:<lens>` and `indexDone:<file>:<lens>` time the full-line scan (the `fullLineScan` mark) and the whole index from `openStart`, apart from the first screen (Z37). On the one-line file they're the same event.
  - `hugeFirstRecord:<lens>` holds `{ row0Chars, beforeLineEnd, next, nextWhileScanning, mounted, maxText, lineMs }`: line 0's row at the first screen, whether the first screen was marked before `fullLineScan`, the next piece fetched through `piece` and whether the scan was still inside line 0 when it arrived, then the mounted rows once the small records have appeared, and the full-line scan time from `openStart`. `beforeLineEnd` is asserted only when `lineMs` exceeds the first-screen budget (PC 50 ms, Mac 100 ms): below that, a lens that waits for the record's end can't be told apart.
  - Memory keys hold the working set and private bytes, each summed over all processes. Private bytes are Windows-only, so they're `null` on the Mac.
- **Environment knobs for the runner:**
  - `RUNS`: samples per first-screen test. Default 30, or 1 when cold.
  - `COLD=1`: one cold sample per reboot, appended under `cold:<key>`, for `1g.jsonl` Raw and `10g.jsonl` Rows only. `indexDoneAtFirstScreen:cold:*` accumulates across reboots.
  - `KEY_SUFFIX`: appended to every key (Task 12 uses `:parallel`), so a re-measurement doesn't overwrite the first.
  - The runner never inherits `TYPOSE_*` variables from the shell. It throws on a zero, negative or missing duration rather than saving it. It records input latency as `insufficient` under 30 samples.
  - **Smoke-only:**
    - `DEEP_ROW` (default 40,000,000) lets a smaller stand-in replace the 10 GiB file.
    - `IDLE_MS` (default 300,000) shortens the NetLog idle.

**Measurement design (found by the scratch run and the review):**
- **Every launch uses a private profile** (`--user-data-dir` under the temp dir), in both the runner and the timer. All spikes run as `spike-app`, and Chromium persists per-host zoom in the shared profile. A leftover 200% zoom halves wheel deltas and rows per screen, and it silently changed the review's deep-reading and first-screen numbers. The private profile persists across runs too, so `launch()` also resets the zoom.
- **First screen opens the file in a running app.** The runner waits for the shell to be visible, then calls `__spike.open`. Opening at launch measures the window's startup instead: `?open=` gave 160–250ms where opening a file took 15–20ms.
- **Shell visible is timed without Playwright**, from `spawnSync` to main's `ready-to-show` wall clock. Playwright's launch adds its own startup work. `--exe` times the packaged build instead of `electron.exe` plus the app directory.
- **"While indexing" samples only until the index is done** (at most 10s), and records how long it sampled.

- [ ] **Step 1: Write the runner and the timer**

`spikes/app/perf/spike-a.e2e.ts`:
```ts
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { percentile } from '../src/renderer/src/perf'

const FIX = resolve(__dirname, '../../.fixtures')
const OUT = resolve(__dirname, `../../results/spike-a-${hostname()}.json`)
const COLD = process.env.COLD === '1'
const RUNS = Number(process.env.RUNS ?? (COLD ? 1 : 30))
const DEEP_ROW = Number(process.env.DEEP_ROW ?? 40_000_000)
// Task 12 re-measures under its own keys (KEY_SUFFIX=:parallel) so the sequential results survive.
const SUFFIX = process.env.KEY_SUFFIX ?? ''
// A private profile: every spike runs as `spike-app`, and Chromium persists per-host zoom in the shared one.
const PROFILE = '--user-data-dir=' + join(tmpdir(), 'typose-spike-a-perf')

const load = (): Record<string, any> => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {})
const save = (key: string, value: unknown): void => {
  const results = load()
  results[key + SUFFIX] = value
  writeFileSync(OUT, JSON.stringify(results, null, 2))
}
const summary = (samples: number[]) => {
  // A duration is never zero or negative; one that is means the measurement itself is broken.
  if (samples.length === 0 || samples.some((s) => !(s > 0))) throw new Error(`invalid samples: ${JSON.stringify(samples.slice(0, 5))}`)
  return { n: samples.length, p50: percentile(samples, 50), p95: percentile(samples, 95), max: Math.max(...samples), samples }
}
/** Warm runs replace the key; cold runs (one per reboot) append to `cold:<key>`. */
const record = (key: string, samples: number[]): void => {
  if (!COLD) return save(key, summary(samples))
  const prior: number[] = load()[`cold:${key}${SUFFIX}`]?.samples ?? []
  save(`cold:${key}`, summary([...prior, ...samples]))
}

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; win: Page }> {
  // Never inherit TYPOSE_* from the shell: a leftover TYPOSE_OPEN opens a second document and corrupts every timing.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_')))
  const app = await electron.launch({ args: ['.', PROFILE], env: { ...base, ...env } as Record<string, string> })
  const win = await app.firstWindow()
  // The profile persists across runs, so a zoom set in it by any earlier run would halve wheel steps and rows per screen.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomLevel(0))
  await win.waitForFunction(() => (window as any).__spike?.open)
  return { app, win }
}

/** Opens a file in an app whose shell is already up and visible: the first-screen gate is about opening, not launching. */
async function openIn(win: Page, file: string, lens: 'raw' | 'rows'): Promise<void> {
  await win.waitForFunction(() => document.visibilityState === 'visible')
  await win.waitForTimeout(500) // let startup work settle
  await win.evaluate(([p, l]) => (window as any).__spike.open(p, l), [join(FIX, file), lens])
}

// Files whose first line is huge (Z37): the first screen is line 0's first piece; the full-line scan is timed apart.
const LONG_FIRST_LINE = ['huge-first.jsonl', 'one-line.jsonl']

/** One first-screen sample, plus whether indexing had finished before it painted (spec §13.1: "without scanning to end of file").
 *  For a huge first line, also the full-line scan and the index, each from `openStart` (Z37). */
async function firstScreenMs(file: string, lens: 'raw' | 'rows'): Promise<{ ms: number; indexDone: boolean; lineMs: number; doneMs: number }> {
  const { app, win } = await launch()
  await openIn(win, file, lens)
  await win.waitForFunction(() => (window as any).__spike.perf.marks.firstScreen)
  if (LONG_FIRST_LINE.includes(file)) await win.waitForFunction(() => (window as any).__spike.indexDone, null, { timeout: 60_000 })
  const sample = await win.evaluate(() => {
    const m = (window as any).__spike.perf.marks
    // Compare marks, not the state at read time: under load this read can lag the paint by hundreds of ms.
    return { ms: m.firstScreen - m.openStart, indexDone: (m.indexDone ?? Infinity) <= m.firstScreen, lineMs: m.fullLineScan - m.openStart, doneMs: m.indexDone - m.openStart }
  })
  await app.close()
  return sample
}

const FIRST_SCREEN: [string, 'raw' | 'rows'][] = COLD
  ? [['1g.jsonl', 'raw'], ['10g.jsonl', 'rows']]
  : [
      ...['1g.jsonl', '10g.jsonl', 'huge-first.jsonl'].flatMap((f) => [[f, 'raw'], [f, 'rows']] as [string, 'raw' | 'rows'][]),
      ['one-line.jsonl', 'raw'] // Z37: a 1 GiB file that is a single line
    ]

for (const [file, lens] of FIRST_SCREEN) {
  test(`first screen: ${file} ${lens}`, async () => {
    const runs = []
    for (let i = 0; i < RUNS; i++) runs.push(await firstScreenMs(file, lens))
    record(`firstScreen:${file}:${lens}`, runs.map((r) => r.ms))
    if (LONG_FIRST_LINE.includes(file)) {
      // Z37: the scan past line 0's end and the whole index are their own keys, never part of the first screen.
      record(`fullLineScan:${file}:${lens}`, runs.map((r) => r.lineMs))
      record(`indexDone:${file}:${lens}`, runs.map((r) => r.doneMs))
    }
    const key = `indexDoneAtFirstScreen:${COLD ? 'cold:' : ''}${file}:${lens}`
    const count = runs.filter((r) => r.indexDone).length
    save(key, COLD ? (load()[key + SUFFIX] ?? 0) + count : count) // cold: x of the reboots so far
  })
}

for (const lens of ['raw', 'rows'] as const) {
  test(`oversized first record (${lens}): first piece before the scan passes the record, small records after it, no item over 64 KiB`, async () => {
    const { app, win } = await launch()
    await openIn(win, 'huge-first.jsonl', lens)
    await win.waitForFunction(() => (window as any).__spike.perf.marks.firstScreen)
    // Z37: the first screen is line 0's first piece, painted before the scan passes the 200 MB record's end.
    const first = await win.evaluate(async () => {
      const s = (window as any).__spike
      const row0 = [...document.querySelectorAll('.vl-row')].find((r) => r.querySelector('.gutter')?.textContent === '1')
      // Usable: its next piece is fetched on demand (spec §3.4's continuation).
      const next = await s.core.call('piece', { doc: s.doc, line: 0, offset: 65_536 })
      const m = s.perf.marks
      return {
        row0Chars: row0?.textContent?.length ?? 0,
        beforeLineEnd: !(m.fullLineScan <= m.firstScreen), // marks, not the state at read time
        next: { offset: next.offset, chars: next.text.length, more: next.more },
        nextWhileScanning: s.perf.marks.fullLineScan === undefined // read after the fetch returned
      }
    })
    await win.waitForFunction(
      () => [...document.querySelectorAll('.vl-row')].some((r) => r.textContent?.includes('line 0000000000') ?? false),
      null,
      { timeout: 60_000 }
    )
    const after = await win.evaluate(() => {
      const m = (window as any).__spike.perf.marks
      const rows = [...document.querySelectorAll('.vl-row')] as HTMLElement[]
      return { mounted: rows.length, maxText: Math.max(...rows.map((r) => r.textContent?.length ?? 0)), lineMs: m.fullLineScan - m.openStart }
    })
    save(`hugeFirstRecord:${lens}`, { ...first, ...after })
    // Waiting for the record's end is only observable when the scan outlasts the first-screen budget (PC 50 ms, Mac 100 ms).
    if (after.lineMs > (process.platform === 'darwin' ? 100 : 50)) expect(first.beforeLineEnd).toBe(true)
    expect(first.row0Chars).toBeGreaterThan(lens === 'raw' ? 65_536 : 200) // the piece (Raw) or its 200-char preview (Rows)
    expect(first.next).toEqual({ offset: 65_536, chars: 65_536, more: true })
    expect(after.maxText).toBeLessThanOrEqual(65_536 + 16) // the 64 KiB piece plus gutter and " …"
    await app.close()
  })
}

test('deep incremental reading, index throughput and memory (10 GiB)', async () => {
  const { app, win } = await launch()
  await openIn(win, '10g.jsonl', 'raw')
  await win.waitForFunction(() => (window as any).__spike.indexDone, null, { timeout: 20 * 60_000 })
  const done = await win.evaluate(() => (window as any).__spike.indexDone)
  save('index10g', { lines: done.lines, bytes: done.bytes, elapsedMs: done.elapsedMs, gbPerSec: done.bytes / 1e9 / (done.elapsedMs / 1000) })
  const box = (await win.locator('.vl-scroller').boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const notches = async (row: number) => {
    await win.evaluate((r) => (window as any).__spike.view.list.scrollToRow(r), row)
    await win.waitForTimeout(200)
    const before = await win.evaluate(() => (window as any).__spike.view.list.firstVisibleRow())
    for (let i = 0; i < 10; i++) await win.mouse.wheel(0, 120)
    await win.waitForTimeout(200)
    return (await win.evaluate(() => (window as any).__spike.view.list.firstVisibleRow())) - before
  }
  const atTop = await notches(0)
  const deep = await notches(DEEP_ROW)
  // The model must match the screen: the row painted at the top edge is the row the scroll state says.
  const painted = await win.evaluate(() => {
    const list = (window as any).__spike.view.list
    const top = [...document.querySelectorAll('.vl-row')].find((el) => {
      const y = el.getBoundingClientRect().top - el.parentElement!.getBoundingClientRect().top
      return y <= 0 && y > -24
    })
    return { gutter: Number(top?.querySelector('.gutter')?.textContent), expected: list.firstVisibleRow() + 1 }
  })
  // PageDown through the real key path, not the method.
  await win.locator('.vl-scroller').focus()
  const before = await win.evaluate(() => (window as any).__spike.view.list.state.top)
  await win.keyboard.press('PageDown')
  const page = await win.evaluate((b) => {
    const list = (window as any).__spike.view.list
    return { moved: list.state.top - b, viewport: list.state.geometry.viewport }
  }, before)
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics())
  const workingSetMB = metrics.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024
  const privateMB = process.platform === 'win32' ? metrics.reduce((s, m) => s + (m.memory.privateBytes ?? 0), 0) / 1024 : null // Windows-only
  save('deepReading', { atTop, deep, painted, page })
  save('memory10g', { workingSetMB, privateMB, budgetMB: totalmem() / 4 / 2 ** 20 })
  expect(atTop).toBe(50) // 10 × 120 px at 24 px rows
  expect(Math.abs(deep - atTop)).toBeLessThanOrEqual(1)
  expect(painted.gutter).toBe(painted.expected)
  expect(page.moved).toBe(page.viewport)
  expect(workingSetMB).toBeLessThan(totalmem() / 4 / 2 ** 20)
  await app.close()
})

test('memory on the 1 GiB fixture', async () => {
  const { app, win } = await launch()
  await openIn(win, '1g.jsonl', 'rows')
  await win.waitForFunction(() => (window as any).__spike.indexDone, null, { timeout: 5 * 60_000 })
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics())
  const workingSetMB = metrics.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024
  const privateMB = process.platform === 'win32' ? metrics.reduce((s, m) => s + (m.memory.privateBytes ?? 0), 0) / 1024 : null // Windows-only
  save('memory1g', { workingSetMB, privateMB, perProcess: metrics.map((m) => ({ type: m.type, mb: m.memory.workingSetSize / 1024 })) })
  expect(workingSetMB).toBeLessThan(1024)
  await app.close()
})

test('64 KiB page fetch round trip (1 GiB, indexed)', async () => {
  const { app, win } = await launch()
  await openIn(win, '1g.jsonl', 'raw')
  await win.waitForFunction(() => (window as any).__spike.indexDone, null, { timeout: 5 * 60_000 })
  const out = await win.evaluate(async () => {
    const s = (window as any).__spike
    const time = async (method: string): Promise<number[]> => {
      const samples: number[] = []
      for (let i = 0; i < 300; i++) {
        // 327 lines × 200 B ≈ 64 KiB, at a random position
        const start = Math.floor(Math.random() * (s.indexDone.lines - 400))
        const t0 = performance.now()
        await s.core.call(method, { doc: s.doc, start, count: 327 })
        samples.push(performance.now() - t0)
      }
      return samples
    }
    return { raw: await time('lines'), rows: await time('rows') }
  })
  save('fetch64k', { raw: summary(out.raw), rows: summary(out.rows) })
  await app.close()
})

test('scrolling, page fetches and input latency while indexing (10 GiB)', async () => {
  const { app, win } = await launch()
  await openIn(win, '10g.jsonl', 'rows')
  await win.waitForFunction(() => (window as any).__spike.perf.marks.firstScreen)
  const scroller = win.locator('.vl-scroller')
  await scroller.focus()
  const box = (await scroller.boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.evaluate(() => {
    const s = (window as any).__spike
    s.perf.startFrames(() => s.view.list.state.top)
  })
  // Sample only while the index is still being built (at most 10 s).
  const started = Date.now()
  let n = 0
  while (Date.now() - started < 10_000 && !(await win.evaluate(() => Boolean((window as any).__spike.indexDone)))) {
    await win.mouse.wheel(0, 120)
    if (++n % 12 === 0) await win.keyboard.press('ArrowDown')
    await win.waitForTimeout(16)
  }
  const sampledMs = Date.now() - started
  const out = await win.evaluate(() => {
    const s = (window as any).__spike
    return { frames: s.perf.stopFrames(), fetches: s.perf.fetches, input: s.perf.inputLatency }
  })
  // Under 30 input samples the latency gate can't be judged; record that instead of a number.
  save('scrollDuringIndexing', {
    frames: out.frames,
    fetch: summary(out.fetches),
    input: out.input.length >= 30 ? summary(out.input) : { insufficient: true, n: out.input.length, samples: out.input },
    sampledMs
  })
  await app.close()
})

test('NetLog: 5 minutes idle with a remote-image Markdown file open', async () => {
  const md = join(FIX, 'remote-images.md')
  writeFileSync(md, '# Remote\n\n![x](https://example.com/a.png)\n\n![y](http://203.0.113.9/b.png)\n')
  const log = join(FIX, 'spike-a.netlog.json')
  const { app } = await launch({ TYPOSE_OPEN: md, TYPOSE_LENS: 'raw', TYPOSE_NETLOG: log })
  await new Promise((r) => setTimeout(r, Number(process.env.IDLE_MS ?? 5 * 60_000)))
  await app.close()
  save('netlogFile', log)
})
```
`spikes/app/perf/shell-visible.mjs`:
```js
// Shell visible (spec §10.2) without Playwright in the loop: spawn Electron, read the wall clock main writes
// on ready-to-show (TYPOSE_SHOWN_FILE), subtract the spawn time.
// Warm:  node perf/shell-visible.mjs --runs 30 [--no-codecache --key shellVisibleWarmNoCodeCache]
// Cold:  node perf/shell-visible.mjs --runs 1 --key shellVisibleCold --append   (once per reboot)
// Packaged build: add --exe dist/win-unpacked/spike-app.exe (the default launch is electron.exe + the app dir).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron') // the binary's path
const opt = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const append = process.argv.includes('--append')
const runs = Number(opt('--runs', '30'))
const warmup = Number(opt('--warmup', append ? '0' : '1'))
const key = opt('--key', 'shellVisibleWarm')
const exe = opt('--exe', null)
if (process.argv.includes('--exe') && !exe) throw new Error('--exe needs a path')
const shownFile = join(tmpdir(), 'typose-shown.txt')
// The perf runner's private profile (every spike runs as `spike-app`; the shared profile persists zoom).
const profile = '--user-data-dir=' + join(tmpdir(), 'typose-spike-a-perf')
// Never inherit TYPOSE_* from the shell (a leftover TYPOSE_OPEN would open a document during the timing).
const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TYPOSE_')))
const env = { ...base, TYPOSE_SHOWN_FILE: shownFile }
if (process.argv.includes('--no-codecache')) env.TYPOSE_NO_CODECACHE = '1'

const samples = []
for (let i = -warmup; i < runs; i++) {
  rmSync(shownFile, { force: true })
  const spawnedAt = Date.now()
  const r = spawnSync(exe ? resolve(appDir, exe) : electron, [...(exe ? [] : ['.']), profile], { cwd: appDir, env, stdio: 'ignore', timeout: 60_000 })
  if (r.error || !existsSync(shownFile)) throw new Error(`run ${i}: ${r.error ?? 'no timing written'}`)
  if (i >= 0) samples.push(Number(readFileSync(shownFile, 'utf8')) - spawnedAt)
}

const out = resolve(appDir, `../results/spike-a-${hostname()}.json`)
const results = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}
const all = append ? [...(results[key]?.samples ?? []), ...samples] : samples
const pct = (p) => [...all].sort((a, b) => a - b)[Math.max(1, Math.ceil((p / 100) * all.length)) - 1]
results[key] = { n: all.length, p50: pct(50), p95: pct(95), max: Math.max(...all), samples: all }
writeFileSync(out, JSON.stringify(results, null, 2))
console.log(key, results[key])
```
`spikes/results/.gitkeep`: create an empty file.

The Raw lens shows the Markdown as text and never fetches images. The point is that **nothing else** in the shell reaches the network while idle. Spike C runs the same assertion against rendered hostile Markdown.

- [ ] **Step 2: Do a quick run to prove the runner works**

Run (`spikes/app`): `npm run build`, then the quick run:
- PowerShell: `$env:RUNS=2; npx playwright test --project=perf spike-a -g "1g.jsonl|1 GiB|huge-first|one-line|oversized"; Remove-Item Env:RUNS`
- Git Bash: `RUNS=2 npx playwright test --project=perf spike-a -g "1g.jsonl|1 GiB|huge-first|one-line|oversized"`

Expected: `9 passed`. `spikes/results/spike-a-<hostname>.json` contains:
- `firstScreen:1g.jsonl:raw` and `firstScreen:1g.jsonl:rows`, with positive samples;
- `indexDoneAtFirstScreen:1g.jsonl:raw` and `:rows`, both `0`;
- `firstScreen`, `fullLineScan` and `indexDone` keys for `huge-first.jsonl` (raw, rows) and `one-line.jsonl` (raw), with positive samples, and `indexDoneAtFirstScreen` for each;
- `indexDoneAtFirstScreen:one-line.jsonl:raw` `0`, and `:huge-first.jsonl:raw` and `:rows` `0` on the PC (Z37);
- `hugeFirstRecord:raw` and `:rows`, with `beforeLineEnd: true` and `next: { offset: 65536, chars: 65536, more: true }`;
- `memory1g`;
- `fetch64k`.

Run: `node perf/shell-visible.mjs --runs 2 --key smokeShellVisible`
Expected: it prints `smokeShellVisible { n: 2, ... }`.

Delete the `smokeShellVisible` key from the results file.

- [ ] **Step 3: Read your own work (rule 8), then commit**

```bash
git add spikes/app/perf spikes/results/.gitkeep
git commit -m "spike(a): perf runner and shell-visible timer covering every Spike A gate"
```

---

## Task 11: Run the gates, check Snap Layouts, run the Mac batch, write REPORT-A

**Files:**
- Create: `spikes/results/spike-a-<pc-hostname>.json` (from the runs), `spikes/results/spike-a-<mac-hostname>.json`, `spikes/results/REPORT-A.md`

- [ ] **Step 1: Warm runs on the PC**

Set up first: Defender on, the 10 GiB fixture present, nothing else heavy running. Note the monitor's refresh rate, because REPORT-A needs it. Open a fresh terminal: no `TYPOSE_*` variables set.

Run (`spikes/app`):
```bash
npm run build
npm run perf:a
node perf/shell-visible.mjs --runs 30
node perf/shell-visible.mjs --runs 30 --no-codecache --key shellVisibleWarmNoCodeCache
```
Expected:
- 14 tests pass;
- the results JSON has:
  - `shellVisibleWarm` and `shellVisibleWarmNoCodeCache`;
  - seven `firstScreen:*` keys and seven `indexDoneAtFirstScreen:*` keys (1g, 10g and huge-first in Raw and Rows; one-line in Raw);
  - `fullLineScan:*` and `indexDone:*` for huge-first (Raw, Rows) and one-line (Raw);
  - `hugeFirstRecord:raw|rows`;
  - `index10g`, `deepReading`, `memory10g`, `memory1g`, `fetch64k`, `scrollDuringIndexing` and `netlogFile`.

A failing `expect` is a gate result, not a bug to hide. Record the number, and only fix the harness if the harness itself is wrong.

**If `index10g.gbPerSec` is below 1.0, do Task 12 now**, before continuing with Step 2.

- [ ] **Step 2: Check the NetLog**

Run (`spikes/tools`): `node netlog-assert.mjs ../.fixtures/spike-a.netlog.json`
Expected: `PASS: no Chromium network-stack activity (Node sockets in main/core host are not covered)`.

If it fails, record each violation verbatim in the report. A Chromium-internal request is a finding (spec §7.3), not something to suppress.

- [ ] **Step 3: Package, then check Snap Layouts on the packaged build (manual)**

Run (`spikes/app`): `npm run build`, then `npm run pack`. The first pack downloads electron-builder's Windows tooling. Launch `dist\win-unpacked\spike-app.exe`.

Check:
- hovering the maximize button shows the Windows 11 Snap Layouts flyout;
- Win+Z shows it too;
- dragging the 40px bar moves the window;
- double-clicking the bar maximizes it.

Record pass or fail, with a screenshot path, in the report. Keep `dist\win-unpacked`, because Step 4 times it.

- [ ] **Step 4: Cold runs (n=5)**

Five times:
1. Restart Windows.
2. Log in and wait 2 minutes for startup noise to settle.
3. Run (`spikes/app`) the shell-visible samples, dev layout and packaged build:
   - `node perf/shell-visible.mjs --runs 1 --key shellVisibleCold --append`
   - `node perf/shell-visible.mjs --runs 1 --key shellVisibleColdPackaged --append --exe dist/win-unpacked/spike-app.exe`

   Alternate their order: dev layout first on reboots 1, 3 and 5, packaged first on reboots 2 and 4. The second launch inherits shared DLLs and drivers the first one warmed.
4. Run the cold first-screen samples:
   - PowerShell: `$env:COLD=1; npx playwright test --project=perf spike-a -g "first screen"; Remove-Item Env:COLD`
   - Git Bash: `COLD=1 npx playwright test --project=perf spike-a -g "first screen"`

Each reboot appends one sample to each of:
- `shellVisibleCold` and `shellVisibleColdPackaged`;
- `cold:firstScreen:1g.jsonl:raw` and `cold:firstScreen:10g.jsonl:rows`.

It also adds its count to `indexDoneAtFirstScreen:cold:1g.jsonl:raw` and `indexDoneAtFirstScreen:cold:10g.jsonl:rows`, so after five reboots each reads "x of 5".

The OS file cache is cold only for the first launch after a reboot. That's a shell-visible sample, so run those first.

- [ ] **Step 5: Mac batch (full budgets)**

On the friend's Mac:
1. Install Rust and Node 24.
2. Clone the repo and run `git switch spike/a`.
3. In `spikes/core/spike-node`: `npm install && npm run build`.
4. In `spikes/core`, generate the fixtures:
   ```bash
   cargo run --release -p fixtures-gen -- jsonl --bytes 1073741824 --line 200 --out ../.fixtures/1g.jsonl
   cargo run --release -p fixtures-gen -- jsonl-huge-first --first 209715200 --bytes 1048576 --line 200 --out ../.fixtures/huge-first.jsonl
   cargo run --release -p fixtures-gen -- jsonl-huge-first --first 1073741824 --bytes 0 --out ../.fixtures/one-line.jsonl
   ```
   Also generate `10g.jsonl` with the same command as on the PC, but only if the Mac has more than 15 GB free.
5. In `spikes/app`: `npm install && npm run build && npm run perf:a && node perf/shell-visible.mjs --runs 30`.
   Tests for a fixture that wasn't generated fail at open; record them as "not run, disk".
6. Cold, if the friend agrees to 5 restarts: after each restart, run `node perf/shell-visible.mjs --runs 1 --key shellVisibleCold --append`. Otherwise record "cold not run".
7. Trackpad check:
   - launch with `TYPOSE_OPEN` pointing at `10g.jsonl` (or `1g.jsonl`): `TYPOSE_OPEN="$PWD/../.fixtures/10g.jsonl" npx electron .`;
   - click into the list, then press F9 (Fn+F9 on a Mac keyboard with default settings);
   - flick-scroll continuously deep in the file for about 10 seconds;
   - press F9 again.

   The title bar shows `max step … (viewport …)`. Gate: max step ≤ viewport. Record the line verbatim.
8. Copy `spikes/results/spike-a-<mac>.json` back, along with the notes.

- [ ] **Step 6: Write REPORT-A.md**

`spikes/results/REPORT-A.md`. Fill every cell from the results JSON; don't round in a direction that changes a verdict. A key recorded as `insufficient` is "not judged", never a pass.
```markdown
# Spike A report — <date>

Machines: PC (i7-12700K, 32GB, RTX 3070 Ti, 980 PRO, Win 11 26200, Defender on, <monitor Hz>) · Mac (<model, chip, RAM, Hz>)
Statistic: warm = p95 of n=30; cold = worst of n=5.
Frame threshold: a long frame is an rAF interval > 20 ms. At <Hz> that means a frame missed by more than <20 − 1000/Hz> ms.

| Gate (spec §13.1) | Threshold PC / Mac | PC result | Mac result | Verdict |
|---|---|---|---|---|
| Shell visible, cold (dev layout / packaged) | < 200 / < 400 ms | | | |
| Shell visible, warm (informational) | — | | | |
| First screen 1/10 GiB Raw/Rows, warm | < 50 / < 100 ms | | | |
| … without scanning to end of file (`indexDoneAtFirstScreen`, 1/10 GiB and one-line; huge-first where its `fullLineScan` p50 exceeds the first-screen budget, otherwise not judged) | 0 of n | | | |
| First screen on a huge first line [Z37]: line 0's first piece visible and usable (huge-first Raw/Rows, one-line 1 GiB Raw), warm | < 50 / < 100 ms | | | |
| First screen 1 GiB Raw + 10 GiB Rows, cold (2 of the 4 combinations) | < 150 ms (PC) | | n/a | |
| Oversized first record [Z37]: first screen marked before the scan passes the record (`hugeFirstRecord.beforeLineEnd`); next piece fetched (`next`); small records shown once the scan passes it | true where `lineMs` exceeds the first-screen budget, else not judged; 64 KiB with `more`; shown | | | |
| Full-line scan completion [Z37], measured apart (`fullLineScan`: huge-first Raw/Rows, one-line Raw), and index done (`indexDone`) | informational | | | |
| Oversized first record: no mounted item > 64 KiB | maxText ≤ 65,552 | | | |
| Deep reading: 10 notches at line 40M vs line 0; painted top row = model row | ±1 line; equal | | | |
| PageDown (key) | exactly one viewport | | | |
| Mac trackpad: max step between frames | ≤ one viewport | n/a | | |
| Index throughput (10 GiB; newline scan only, see Notes) | ≥ 1 / ≥ 0.5 GB/s | | | |
| Input latency during indexing (keydown + wheel, n = …) | < 50 ms (max) | | | |
| 64 KiB page fetch round trip (Raw / Rows) | p95 < 3 ms | | | |
| Frames while scrolling during indexing (sampledMs = …) | ≥ 99% ≤ 20 ms rAF interval, no stall > 50 ms | | | |
| Memory, 1 GiB fixture (working set / private; private is Windows-only) | < 1 GiB total | | | |
| Memory, 10 GiB fixture (working set / private; private is Windows-only) | < 25% RAM | | | |
| Snap Layouts flyout (packaged) | appears | | n/a | |
| NetLog assertion, 5 min idle (Chromium stack only) | 0 violations | | | |
| V8 code cache effect (warm shell, with / without; ~12 kB bundle) | informational | | | |

## Decisions this feeds back into the spec
- **Transport:** keep structured clone, or move hot pages to transferable ArrayBuffers? This turns on the 64 KiB fetch p95 against 3 ms (spec §3.4).
- **Indexer:** stays sequential, or Task 12's parallel indexer? This turns on throughput against the gate (spec §3.5 says rayon; this spike decides whether it's needed). If Task 12 ran, report both: the `:parallel` keys sit beside the sequential ones. Say which indexer each number used: Task 11 Step 1 ran sequential, while the NetLog, packaged, cold and Mac numbers (Steps 2–5) ran on the parallel indexer.
- **Oversized first record [Z37]:** the first screen no longer waits for the scan past the 200 MB record, so report the full-line scan completion beside it. Continuation pieces are fetched by byte offset (`piece`) but not rendered as their own items; that, and an opaque generation-checked continuation token, are M1 (spec §3.4).
- **Code cache:** keep `codeCache` on the scheme (spec §10.1)? The spike's bundle is about 12 kB, so a null result here says nothing about the real app's bundle.
- **Shell visible:** compare the dev layout and the packaged build. If the cold gate fails, give a breakdown (process start → app ready → window created → first paint) and the proposed budget.
- **Proxy:** `--no-proxy-server` is needed for the NetLog gate (Task 8). Decide the spec §7.3 addition, and how user-clicked remote images then reach a proxied network.
- **Node-side network tripwire:** the NetLog sees only Chromium's stack. Spec §7.3 needs a second check for Node sockets and DNS in main and the core host. For example, wrap `net.Socket.prototype.connect` and `dns.lookup` there under a test flag and fail on any call.
- **Anything else that failed:** the exact number, the suspected cause, and the spec section it changes.
```

- [ ] **Step 7: Read your own work (rule 8), then commit**

Re-read `REPORT-A.md` in full against the JSON files.
```bash
git add spikes/results
git commit -m "spike(a): gate results and REPORT-A"
```
Leave `spike/a` unmerged. Spike C and Spike B branch from it.

---

## Task 12 (only if the index throughput gate fails): parallel block scanning with rayon

Run this between Task 11 Step 1 and Step 2, so REPORT-A can compare both indexers. The re-measure saves under `:parallel` keys, so the sequential results stay. From then on the addon runs the parallel indexer, so Task 11's Steps 2–5 (NetLog, packaged build, cold runs, Mac batch) measure it.

**Files:**
- Modify: `spikes/core/spike-core/Cargo.toml` (add `rayon = "1.12"` under `[dependencies]`)
- Modify: `spikes/core/spike-core/src/index.rs` (add `build_parallel` and one test)
- Modify: `spikes/core/spike-node/src/lib.rs` (call `build_parallel`)

**Interfaces:**
- **Consumes:** `Builder`, `read_block`, `block_len` from Task 5.
- **Produces:** `pub fn build_parallel(file, len, cfg, hashes, shared, on_progress, batch: usize) -> Result<(), StoreError>`. It produces exactly the same checkpoints as `build`.

- [ ] **Step 1: Write the failing test**

Add to `index.rs`'s test module, at its end (after the `proptest!` block):
```rust
    #[test]
    fn parallel_build_matches_sequential() {
        // ~6.5 MiB with lines of varying length, so blocks and batches split lines.
        let mut bytes = Vec::new();
        let mut n = 0usize;
        while bytes.len() < 6 * CHUNK + 12_345 {
            bytes.extend(std::iter::repeat_n(b'a', (n * 7919) % 3000));
            bytes.push(b'\n');
            n += 1;
        }
        let cfg = IndexConfig { cp_lines: 64, cp_bytes: 100_000, block: CHUNK };
        let (_, seq) = index_bytes("seq", &bytes, cfg);
        let path = temp_file("par", &bytes);
        let store = ByteStore::open(&path).unwrap();
        let shared = RwLock::new(LineIndex::default());
        build_parallel(&File::open(&path).unwrap(), store.len(), cfg, &store.hashes(), &shared, |_| {}, 3).unwrap();
        let par = shared.into_inner().unwrap();
        assert_eq!(par.checkpoints, seq.checkpoints);
        assert_eq!(par.line_count(), seq.line_count());
    }
```
Run (`spikes/core`): `cargo test -p spike-core parallel`
Expected: compile error, because `build_parallel` isn't defined.

- [ ] **Step 2: Implement**

Add `rayon = "1.12"` to `[dependencies]`. Then add to `index.rs`, below `build`:
```rust
/// Parallel variant: `batch` blocks are read and scanned on rayon's pool, then fed to the same
/// `Builder` in file order, so the checkpoints are identical to `build`'s. The first batch is one
/// block, so the first screen's progress event isn't held back by a whole batch.
pub fn build_parallel(
    file: &File,
    len: u64,
    cfg: IndexConfig,
    hashes: &ChunkHashes,
    shared: &RwLock<LineIndex>,
    mut on_progress: impl FnMut(Progress),
    batch: usize,
) -> Result<(), StoreError> {
    use rayon::prelude::*;
    let started = Instant::now();
    let mut b = Builder::new(cfg);
    let blen = block_len(&cfg) as u64;
    let mut pos = 0u64;
    while pos < len {
        let n = if pos == 0 { 1 } else { batch };
        let starts: Vec<u64> = (0..n as u64).map(|i| pos + i * blen).take_while(|&s| s < len).collect();
        let scanned: Vec<Result<Vec<u32>, StoreError>> = starts
            .par_iter()
            .map(|&s| {
                let mut buf = vec![0u8; (len - s).min(blen) as usize];
                let block = read_block(file, &mut buf, s, hashes)?;
                Ok(memchr_iter(b'\n', block).map(|r| r as u32).collect())
            })
            .collect();
        for (&s, rels) in starts.iter().zip(scanned) {
            b.block(s, (s + blen).min(len), rels?.into_iter().map(|r| r as usize));
        }
        pos = (pos + n as u64 * blen).min(len);
        let lines = b.publish(shared, pos, false);
        on_progress(Progress { lines, bytes: pos, done: false, elapsed_ms: started.elapsed().as_millis() as u64 });
    }
    let lines = b.publish(shared, len, true);
    on_progress(Progress { lines, bytes: len, done: true, elapsed_ms: started.elapsed().as_millis() as u64 });
    Ok(())
}
```
Run: `cargo test -p spike-core`
Expected: `17 passed` (Task 6's 16 plus `parallel_build_matches_sequential`).

- [ ] **Step 3: Use it in the addon and re-measure**

In `spikes/core/spike-node/src/lib.rs`:
- change the import to `use spike_core::index::{build_parallel, IndexConfig, LineIndex};`;
- replace `build(&file, len, IndexConfig::default(), &hashes, &index, |p| {` with `build_parallel(&file, len, IndexConfig::default(), &hashes, &index, |p| {`;
- add the batch argument after the closure's closing `}`: `}, std::thread::available_parallelism().map_or(4, |n| n.get()));`.

Run (`spikes/core/spike-node`): `npm run build`.
Run (`spikes/app`): `npm run build`, then re-measure under separate keys:
- PowerShell: `$env:KEY_SUFFIX=':parallel'; npx playwright test --project=perf spike-a -g "deep|scrolling|first screen: (1g|10g)"; Remove-Item Env:KEY_SUFFIX`
- Git Bash: `KEY_SUFFIX=':parallel' npx playwright test --project=perf spike-a -g "deep|scrolling|first screen: (1g|10g)"`

Expected: `6 passed`. The results JSON gains:
- `index10g:parallel`, `deepReading:parallel`, `memory10g:parallel` and `scrollDuringIndexing:parallel`;
- four `firstScreen:*:parallel` and four `indexDoneAtFirstScreen:*:parallel` keys.

The sequential keys are unchanged. In REPORT-A, record both throughputs, both first-screen sets, and the frame and latency numbers under parallel indexing. Parallel scanning competes with the UI for cores.

- [ ] **Step 4: Read your own work (rule 8), then commit**

```bash
git add spikes/core/spike-core spikes/core/spike-node/src spikes/core/Cargo.lock
git commit -m "spike(a): parallel block scanning (throughput gate failed sequentially)"
```

---

## Notes for the checkpoint (deviations from the spec, by design)

- **Spec §13.1 says Spike A builds a `memchr` + `rayon` indexer.** This plan builds sequential first and adds rayon only if the throughput gate fails (Task 12). Sequential scanning reached ~4 GB/s warm in the scratch run, against a 1 GB/s gate.
- **Spec §3.5 says Spike A measures sequential CSV indexing.** That needs the CSV record index, which Spike C builds, so the measurement and the 100 MB CSV fixture are in Spike C. The 5,000-column CSV is in Spike B (Grid).
- **Spec §10.3 takes frame timing from Chromium tracing.** The spike uses rAF intervals, with a 20 ms threshold (= one missed 60 Hz frame). If the checkpoint wants tracing-grade numbers, that's an M7 harness item.
- **Spec §3.4's `open` returns `firstPage`.** The spike's `open` doesn't. The renderer waits for the first progress event, then requests a page. The measured first screen includes those extra hops, so a pass here is conservative.
- **Progress cadence:** spec §3.4 says 5–10 Hz. The spike exempts events while fewer than 256 lines are known, so a first screen never waits on the throttle. This is a precaution: no fixture here makes it matter. The independent review removed it and the first-screen numbers didn't move.
- **Stale requests aren't cancelled** (spec §3.4). Each core read finishes in a few milliseconds, at most two are in flight, and a stale page is simply cached. Cancellation arrives with the versioned protocol in M1.
- **The continuation is a byte offset, not spec §3.4's opaque token** (Z37). `piece(line, offset)` trusts the caller's offset, and napi reads a negative or non-finite offset as 0. A `more` piece continues at `offset + 65,536`. A piece cut at 64 KiB can split a UTF-8 sequence, which decodes lossily as U+FFFD on both sides. M1's versioned protocol makes it a generation-checked token, and Spike C's byte maps handle the split. The spike lens doesn't render continuation pieces as their own items. It is also a separate, lens-less `piece` RPC returning raw text, not spec §3.4's `page(doc, lens, continuation)`.
- **The index is leaner than spec §3.5's.** Checkpoints don't record the block's UTF-16 length or a non-ASCII flag, and JSONL has no per-line parse status. So the throughput gate measures newline scanning plus chunk hashing only. Spike C measures decoding costs.
- **Overscan is 10 rows, not one viewport** (spec §5.3). It's enough for the spike's gates; the accessibility window is Spike B's.
- **`close` doesn't stop an indexing thread.** Brief §8.2 wants close mid-index to free everything. That's M1, with cancellation.
- **Cold first screen covers 2 of the 4 file × lens combinations** (1 GiB Raw, 10 GiB Rows), to keep five reboots practical.
- **`store::testutil::temp_file` never deletes its files.** A full Spike C replay leaves about 500 MB in `%TEMP%`, so clear the `spike-core-*` test files between runs. M1's test helpers clean up on drop.
- **The thumb-drag gate in `setRowCount` trusts `pointerup`.** If a release is lost (there's no `pointercancel` or `blur` handler), the thumb stops tracking the growing total until the next click. The view still shows the right rows. Also, no unit test pins `build_parallel`'s one-block first batch: only the `:parallel` first-screen keys guard that latency.
- **No typecheck:** the spike's TypeScript is only transpiled by Vite/esbuild. M1 adds `tsc --noEmit` to the gate.
- **Interface names are consistent across tasks:**
  - `ByteStore::{open, open_with, chunk, read, len, hashes}`;
  - `ChunkHashes::{check, len}`;
  - `build` / `build_parallel` / `locate_line` / `LineIndex::{line_count, checkpoint_for}`;
  - `pages::{lines, piece, rows}`;
  - napi `Doc.{open, size, startIndex, lines, piece, rows}`;
  - `ScrollState.{moveBy, moveTo, confirmNative, onNativeScroll, setTotal, setViewport, top, geometry}`;
  - `VirtualList.{setRowCount, refresh, scrollToRow, pageDown, visibleRange, firstVisibleRow, state}`;
  - `LensView.{setRowCount, list}`;
  - `PerfLog.{mark, fetch, startFrames, stopFrames, marks, fetches, inputLatency}`;
  - `__spike.{core, perf, open, doc, view, indexDone}`.
