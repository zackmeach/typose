# Changelog

## 0.1.1

A fix release, still a pre-release for Windows x64, and still not code-signed. Install `Typose-0.1.1-setup.exe`, over 0.1.0 if you have it, or unzip `Typose-0.1.1-win-x64.zip` into a new folder and run `Typose.exe`.

- **`typose.cmd` is no longer in the package.** 0.1.0 shipped it in `resources\bin`. Run from PowerShell with a file name that contains `&` and no space, it ran the rest of the name as a command. Nothing put it on PATH. On Windows the command line is `Typose.exe -- <path>…`. Installing 0.1.1 over 0.1.0 removes it. Unzipping 0.1.1 doesn't: if you unzipped 0.1.0, delete that folder, or at least its `resources\bin\typose.cmd`. If you copied `typose.cmd` anywhere else, delete the copy.
- After a restart with a JSON, JSONL or YAML file open, or a quick switch away from one, the status line no longer says "Structured view unavailable · memory budget is full" when memory isn't short. In those cases the grid and the YAML tree no longer report a full budget either. A Markdown file's Rendered tab no longer stays off with "Typose's memory budget is full" when memory isn't short.
- The installer no longer leaves a 112 MB copy of itself in `%LOCALAPPDATA%\typose-updater`. Installing 0.1.1 over 0.1.0 removes 0.1.0's copy. If you have already uninstalled 0.1.0, delete that folder yourself.
- Typose now takes a file's identity and its contents from one open of the file. In 0.1.0, a file of the same length swapped in at that path while Typose opened it, and swapped back out before Typose first read it, could be shown in the first one's place.
- Code in Typose's own window can no longer write to the clipboard without a Copy command. Nothing in 0.1.0 is known to have done so.

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
- If Reopen closed tab, Back, or opening a file from a folder fails (for example because that file was deleted) just as a YAML file's Tree is being prepared, the YAML file's Tree tab can stay at "Preparing Tree…". Reload the YAML file (Ctrl+R), or select another file's tab, then the YAML file's tab again.
- If Reopen closed tab, Back, or opening a link or a file from a folder fails just as a Markdown file's images or diagrams, or a transcript's items, are loading, some images can say "Memory budget is full", a diagram or formula can stay as its source text, and transcript items can say the memory budget is exceeded, though memory isn't short. Select another file's tab, then this one again.
- The status line keeps its last message on every tab until another message replaces it, and doesn't say which file it is about.
- When an image or a link's target is missing, the message includes the system's own error text, such as "io: The system cannot find the file specified. (os error 2)".
- In Raw, a file whose lines are very long runs of emoji can freeze the window when it first opens: 1.8 seconds on a Core i7-12700K for a test file of 40 lines, each about 30,000 UTF-16 units of emoji, and longer on a slower PC.
- Printing:
  - Printed Markdown leaves out images and task checkboxes. Mermaid diagrams do print.
  - A document printed with Microsoft Print to PDF has no selectable text and is large: 2,000 lines of plain text made a 34-page, 17.7 MB PDF.
  - A print job over 1,000 pages is refused.

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
- After Typose restarts with a JSON, JSONL, or YAML file open, or when you switch quickly away from one, the status line can read "Error: Structured view unavailable · memory budget is full" although memory isn't short. The file shows normally when you select its tab again.
- The status line keeps its last message on every tab until another message replaces it, and doesn't say which file it is about.
- When an image or a link's target is missing, the message includes the system's own error text, such as "io: The system cannot find the file specified. (os error 2)".
- In Raw, a file whose lines are very long runs of emoji can freeze the window when it first opens: 1.8 seconds on a Core i7-12700K for a test file of 40 lines, each about 30,000 UTF-16 units of emoji, and longer on a slower PC.
- Printing:
  - Printed Markdown leaves out images and task checkboxes. Mermaid diagrams do print.
  - A document printed with Microsoft Print to PDF has no selectable text and is large: 2,000 lines of plain text made a 34-page, 17.7 MB PDF.
  - A print job over 1,000 pages is refused.
