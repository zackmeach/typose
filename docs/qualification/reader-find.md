# Find in Raw and Rendered

Ctrl+F opens Find in the focused reader or link preview. Enter and F3 advance through matches. Shift+Enter and Shift+F3 go backward. Escape closes Find and returns focus to the reader. The bar includes a case toggle and buttons for both directions.

Raw searches the verified decoded source, including text beyond the usual long-line preview. The current match has a source excerpt with its physical line and byte offset. Counts update as scanning advances. Literal queries accept up to 512 UTF-16 units and use Unicode lowercase per scalar when case is off.

Rendered searches displayed Markdown text across inline formatting. It collapses ordinary whitespace, preserves preformatted text, and excludes hidden link destinations. A change to displayed text, such as an image replacing its placeholder, invalidates the old results. Both readers limit simultaneous visible secondary highlights to 128 while counting the full document.

The Windows workflows in `e2e/reader-find.e2e.ts` cover a distant long-line match, navigation and wrapping, query replacement on a 101 MiB file, refusal and recovery under a memory limit, a match spanning Markdown formatting and a soft line break, and search inside an open preview.
