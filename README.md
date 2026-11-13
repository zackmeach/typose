# Typose

Typose is a fast, local viewer for files and workspaces relevant for the agentic era.

It's a read-only desktop viewer for Markdown, text, CSV, TSV, JSON, JSONL, and YAML files on your machine. Open a file directly, browse a folder, or keep related files side by side. Switch to Raw when you need to see the source.

| File type | What you can do |
| --- | --- |
| Markdown | Read rendered Markdown, up to 8 MB a file, with tables, math, Mermaid diagrams, and supported local images. Images on the web aren't loaded: Typose makes no network requests. |
| CSV and TSV | Browse a grid, choose the delimiter and header behavior, and copy cells or ranges. |
| JSON and YAML | Expand a tree to inspect keys, values, and nested structures. |
| JSONL | Browse records by row. Recognized Claude Code sessions and OpenAI chat records also have a Transcript view. |
| Plain text | Read, search, and jump to a line in Raw. |

Typose reads files on your machine and leaves the originals untouched. Its Rust core reads large files in pages and indexes them in the background. Raw is the fallback when a richer view reaches a format or memory limit.

## Install on Windows

Download `Typose-0.1.0-setup.exe` from the [latest release](https://github.com/zackmeach/typose/releases) and run it. It installs for your Windows account only, with no administrator prompt.

The installer adds Typose to **Open with** for Markdown, text, log, CSV, TSV, JSON, JSONL, and YAML files. It never sets Typose as their default app. A file type you've chosen an app for keeps it; for a type you haven't, Windows may open Typose or ask which app to use. To remove Typose, uninstall it in **Settings → Apps → Installed apps**.

To run Typose without installing it, download `Typose-0.1.0-win-x64.zip`, unzip it, and run `Typose.exe`. Keep the files beside it together.

### Typose isn't code-signed yet

Windows can't confirm who published an unsigned app:

- **SmartScreen** shows "Windows protected your PC" when you run the installer, and names the publisher as **Unknown publisher**. Select **More info**, then **Run anyway**.
- **Smart App Control**, on a PC where it's turned on, may block Typose. It has no way to allow a single app, so Typose can't run on that PC until its releases are signed.

Releases are to be signed from 0.2.0. See the [code signing policy](docs/code-signing-policy.md).

## Systems

| System | Release | What works |
| --- | --- | --- |
| Windows x64 | 0.1.0: installer and zip | Everything in this README |
| macOS and Linux | Not released yet | Built from source: single files only. Folders, links between local files, and local images in Markdown work on Windows only for now. |

## Known issues in 0.1.0

- On a PC with 8 GB of RAM, a Markdown file larger than about 7 MB opens as plain text only: its Rendered tab stays off, with "Typose's memory budget is full".
- When Typose's memory budget is full, another file won't open ("Typose's memory budget is full. Close a file, then Retry."). Typose doesn't close files to make room.
- In Rendered Markdown, HTML comments and most HTML tags, such as `<div>` or `<p align="center">`, show as literal text.
- WebP images, and images over 8 MiB, show a placeholder instead of the picture.
- Task-list checkboxes (`- [x]`, `- [ ]`) are drawn in faint grey, so done and not-done items are hard to tell apart.
- Links:
  - `[[Wiki links]]` show as broken and do nothing.
  - `![[...]]` embeds work only for an image file at that exact path; other embeds show a placeholder.
  - A link to a heading in another file (`other.md#section`) doesn't open; Typose says "This link has no supported destination".
  - Ctrl+clicking a link to a file that's already open opens it again in a second tab.
  - Links to files on another drive, or outside the folder you opened, don't open.
  - Links to PDFs and other files Typose can't show don't open them in their own app; Typose says it can't open them.
- Quick open searches only the first 3,500 files and subfolders of each open folder (1,500 each when 16 folders are open), so files deep in a large folder may not appear.
- You can open at most 16 folders, and the sidebar loads at most 4,096 entries of a folder. The messages for both call it a "demo limit".
- HTML files open as source text, not as web pages.
- Each Ctrl+scroll step zooms by 10%, however small the movement, so a touchpad pinch jumps quickly between 50% and 200%.
- Printing:
  - Printed Markdown leaves out images and task checkboxes. Mermaid diagrams do print.
  - A document printed with Microsoft Print to PDF has no selectable text and is large: 2,000 lines of plain text made a 34-page, 17.7 MB PDF.
  - A print job over 1,000 pages is refused.

[`CHANGELOG.md`](CHANGELOG.md) lists what each release changed.

## Build from source

Windows x64 is the primary development target. macOS and Linux have CI workflows, and some local file features are Windows-specific.

Install Git, Node.js 24, [Rustup](https://rustup.rs/), and Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK. Rustup uses the version pinned in [`rust-toolchain.toml`](rust-toolchain.toml).

```powershell
git clone https://github.com/zackmeach/typose.git
cd typose
npm ci
npm run build:addon
npm run package
.\app\dist\win-unpacked\Typose.exe
```

The package is an unpacked app. Keep `Typose.exe` and the files alongside it together if you move it. `npm run package:win` also builds the installer and zip in `app\dist`.

On macOS (Apple silicon) and Linux, install Git, Node.js 24, and Rustup (and on macOS the Xcode Command Line Tools), run the same commands up to `npm run package`, then open `app/dist/mac-arm64/Typose.app` or run `app/dist/linux-unpacked/typose`. On Ubuntu 24.04 and later, AppArmor's limit on unprivileged user namespaces stops Electron's sandbox from starting; CI lifts it with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

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

## Code signing policy

See [`docs/code-signing-policy.md`](docs/code-signing-policy.md).

## License

Typose source code is available under either the [MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at your option. [Bundled fonts](app/renderer/assets/fonts/README.md) and [vendored Rust crates](core/vendor/) carry their own notices and licenses.
