# CSV Grid preview

Opening a CSV or TSV starts in Raw while Typose prepares its Grid. Grid and Raw share a physical source-line anchor, including inside quoted multiline records. Grid pages both axes, preserves literal cell text, distinguishes missing fields from empty values, and opens a bounded value inspector on Enter. File info shows the detected delimiter in Auto mode and supports header and delimiter overrides. UTF-16 files open in Raw.

The viewport keeps at most 512 cells and copies at most 128 UTF-16 units per cell for display. Inspecting a value requests its first piece again and follows native continuations. Raw and Grid have separate allowances on the same view. The Grid peak remains charged through a lens switch and enters the retirement allowance on Reload.

The Windows package tests exercise semicolon detection, escaped quotes, multiline and ragged records, a reversible header, literal `001`, and keyboard focus on data column 5,000. Both passed in the integrated checkout. The Grid cache, workspace and lens-budget checks also passed. Local evidence is in `.evidence/audit/csv-info-nav.log` and the Checkpoint B package record.

This preview uses fixed column widths. Sampled widths and types, category pills, grouped problem summaries, encoding overrides, Find, sorting and range copy remain open. See [native CSV qualification](csv-core.md) for parser coverage.
