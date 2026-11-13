# Changelog

## 0.1.0

The first release, a pre-release for Windows x64. It is not code-signed.

- Install it for the current user, without an administrator prompt, with `Typose-0.1.0-setup.exe`, or unzip `Typose-0.1.0-win-x64.zip` and run `Typose.exe`.
- The installer adds Typose to **Open with** for Markdown, text, log, CSV, TSV, JSON, JSONL and YAML files. It never sets Typose as their default app. A type you've chosen an app for keeps it; for a type you haven't, Windows may open Typose or ask which app to use. Uninstalling removes Typose from Open with.
- Read rendered Markdown with tables, math, Mermaid diagrams and supported images; browse CSV and TSV in a grid; expand JSON and YAML as a tree; browse JSONL by row, with a Transcript view for Claude Code sessions and OpenAI chat records; read, search and jump to a line of any text file in Raw.
- Open a file or a folder, and keep related files side by side.
- Typose reads files without changing them, and makes no network requests.

### Known issues

- Typose isn't code-signed. SmartScreen shows "Unknown publisher": select **More info**, then **Run anyway**. On a PC with Smart App Control turned on, Windows may block Typose, with no way to allow it.
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
