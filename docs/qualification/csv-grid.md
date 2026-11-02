# CSV Grid

Opening a CSV or TSV starts in Raw while Typose prepares its Grid. Grid and Raw share a physical source-line anchor, including inside quoted multiline records. Grid pages both axes, preserves literal cell text, distinguishes missing fields from empty values, and opens a bounded value inspector on Enter. File info shows the detected delimiter in Auto mode and supports header and delimiter overrides. UTF-16 files open in Raw.

The viewport keeps at most 512 cells and copies at most 128 UTF-16 units per cell for display. Inspecting a value requests its first piece again and follows native continuations. Raw and Grid have separate allowances on the same view. The Grid peak remains charged through a lens switch and enters the retirement allowance on Reload.

The Windows package tests exercise semicolon detection, escaped quotes, multiline and ragged records, a reversible header, literal `001`, and keyboard focus on data column 5,000. Both passed in the integrated checkout. The Grid cache, workspace and lens-budget checks also passed. Local evidence is in `.evidence/audit/csv-info-nav.log` and the Checkpoint B package record.

Ctrl+F searches decoded cell values across the file. Next and Previous follow the current sort order and scroll the matching cell into view. The active match has a text excerpt when the result lies beyond the cell preview. Typose waits for the CSV index to finish before searching or sorting. Counts update as Find scans.

Click a column header to cycle through ascending, descending and original order. Enter and Space operate a focused header. Equal values retain source order in either direction, and the gutter always shows the original data row number. A numeric column sorts numerically. Sorting, selecting and copying leave the source file untouched.

Click a cell, then Shift+click, drag, or use Shift+Arrow to extend the selection. Click a row number or use Shift+Space to select a row. Use Ctrl+Space or the column header menu to select a column. Ctrl+C (Cmd+C on Mac) copies full values as quoted TSV in display order. Whole-column copies include the header when enabled. Copies over 10 MiB require confirmation. The clipboard limit is 16 MiB of UTF-8 text, and a refused or cancelled job writes nothing.

Column widths are fixed. Sampled widths, type icons, category pills, grouped problem summaries and encoding overrides remain open. The Windows interaction tests are in `e2e/grid-interactions.e2e.ts` and `e2e/grid-copy-large.e2e.ts`. They record the exact string passed to Electron's clipboard writer in the isolated app process. See [native CSV qualification](csv-core.md) for the parser and [reader Find](reader-find.md) for the other two search modes.
