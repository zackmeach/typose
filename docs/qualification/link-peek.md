# Local link preview

Click a local link in Markdown to open its target in a preview. The source reader stays mounted. Escape, Ctrl+W, the close button and the scrim dismiss the preview. Open as tab and Open to side transfer the preview's document into a card. Ctrl+click opens a tab directly. Shift+click uses a neighboring card or opens a second card when there is room.

CSV and TSV targets use the same checked native route as Markdown and TXT. The source must be Markdown. A nested link replaces the document inside the preview and saves its source-line anchor for Back. Dismissing the preview returns focus to the source link.

On Windows, the production package opened a relative `tasks.csv` as a Grid, promoted it beside the source, and closed the side card. A separate hooks run checked native document identity through promotion and cleanup through Escape and Ctrl+W. The longer folder and nested-link checks compare the untouched source reader, scroll offset and link position from pointerdown. Back inside the preview reopens the saved line. Evidence is in `.evidence/audit/csv-peek-first-tests.log`, `.evidence/audit/peek-place-probe-outside.log` and `.evidence/audit/csv-info-nav.log`.

Qualification covers these focused workflows. Cross-platform behavior, image-heavy overlap, stress cases, and migration of older tests that assume plain-click replacement remain open. The separate [Grid qualification](csv-grid.md) lists the preview's interaction and metadata limits.
