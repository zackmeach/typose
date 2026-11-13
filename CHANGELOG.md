# Changelog

## 0.1.0

The first release, a pre-release for Windows x64. It is not code-signed.

- Install it for the current user, without an administrator prompt, with `Typose-0.1.0-setup.exe`, or unzip `Typose-0.1.0-win-x64.zip` and run `Typose.exe`.
- The installer adds Typose to **Open with** for Markdown, text, log, CSV, TSV, JSON, JSONL and YAML files. It never sets Typose as their default app, and a type that opens with another app keeps it; for a type no other app opens, Windows itself may open Typose. Uninstalling removes it from Open with.
- Read rendered Markdown with tables, math, Mermaid diagrams and supported images; browse CSV and TSV in a grid; expand JSON and YAML as a tree; browse JSONL by row, with a Transcript view for Claude Code sessions and OpenAI chat records; read, search and jump to a line of any text file in Raw.
- Open a file or a folder, and keep related files side by side.
- Typose reads files without changing them, and makes no network requests.

### Known issues

- A Markdown file near the 8 MiB limit shows as raw text on a machine with 8 GB of memory.
