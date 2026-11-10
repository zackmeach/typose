# Typose

Typose is a read-only desktop viewer for local Markdown, text, CSV, TSV, JSON, JSONL, and YAML files. Open a file directly, browse a folder, or keep related files side by side. Switch to Raw when you need to see the source.

| File type | What you can do |
| --- | --- |
| Markdown | Read rendered Markdown with tables, math, Mermaid diagrams, and supported images. |
| CSV and TSV | Browse a grid, choose the delimiter and header behavior, and copy cells or ranges. |
| JSON and YAML | Expand a tree to inspect keys, values, and nested structures. |
| JSONL | Browse records by row. Recognized Claude Code sessions and OpenAI chat records also have a Transcript view. |
| Plain text | Read, search, and jump to a line in Raw. |

Typose reads files on your machine and leaves the originals untouched. Its Rust core reads large files in pages and indexes them in the background. Raw is the fallback when a richer view reaches a format or memory limit.

## Build and run on Windows

Typose is in development. Windows x64 is the primary development target. macOS and Linux have CI workflows, and some local file features are Windows-specific. Build from source to try it.

Install Git, Node.js 24, [Rustup](https://rustup.rs/), and Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK. Rustup uses the version pinned in [`rust-toolchain.toml`](rust-toolchain.toml).

```powershell
git clone https://github.com/zackmeach/typose.git
cd typose
npm ci
npm run build:addon
npm run package
.\app\dist\win-unpacked\Typose.exe
```

The package is an unpacked app. Keep `Typose.exe` and the files alongside it together if you move it.

## Development

- [`app/`](app/) contains the Electron shell, React UI, and TypeScript core host.
- [`core/`](core/) contains the Rust reader, parsers, and Node addon.
- [`e2e/`](e2e/) contains the Playwright desktop tests.

After building the native addon, run the following from the repository root.

```powershell
npm run lint
npm run check
cargo test --locked --manifest-path core/Cargo.toml
```

Build the standalone package before running `npm run e2e:smoke`, which includes packaged-app tests.

## License

Typose source code is available under either the [MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at your option. [Bundled fonts](app/renderer/assets/fonts/README.md) and [vendored Rust crates](core/vendor/) carry their own notices and licenses.
