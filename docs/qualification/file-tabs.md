# File tabs: first M2 slice

One window keeps permanent file tabs and displays one selected card. Opening an identical manual path focuses its existing tab. Startup and second-instance batches preserve file order. Duplicate filenames show their parent folder; an overflow chooser lists every open path.

Selection retains each tab's source line and explicit Raw/Rendered choice. The selected lens alone owns DOM, cached page payloads and image Blobs. Inactive tabs retain scalar metadata, their native document/index and any local filesystem capability. They do not retain a renderer first page or its view reservation. Selection reads the retained native document; it does not reopen a display path or restart indexing.

The active tab has a close control and Close tab menu command. Arrow keys, Home and End select within the file row; Enter/Space activates its focused tab and Delete closes it. Ctrl+W closes the selected tab; Ctrl+Tab/Ctrl+Shift+Tab and the platform's specified alternatives select adjacent tabs. Closing the last tab leaves the empty card. Mac accelerators require separate Mac qualification.

## Ownership and refusal

Manual and capability-derived tabs use distinct keys. Following a local link still performs the existing capability check before replacing its source tab. An inactive derived tab keeps that capability, but a core restart cannot recreate it from its display path: manual selection remains required.

An explicit manual open while the core is stopped is visibly queued. Once the core returns it opens a new tab; the lost document keeps its own recovery tab. This replaces M1's single-card behavior of renaming that card before Reopen.

Native caches lose elastic growth on deactivation. Under the cache mutex, excess chunk allocations drop before their reservation shrinks to the paid floor of up to four chunks. Late inactive reads replace within that floor. Reactivation permits future growth without discarding document identity, hashes or indexing progress.

Leaving a view deactivates its captured native identity after disposal. Pending activation/Reload ownership prevents delayed completions from reviving an unmounted view or stealing a newer reservation. Reload can finish in an inactive tab with updated generation metadata and indexing; a terminal filesystem failure closes the owned document and leaves a failed pill.

## Persistent UI reservation

The host keeps workspace UI and selected-view shares separate, backed by one native renderer reservation. The selected view still pays the existing Raw/Rendered formulas and retired-tree allowance.

The workspace charge uses the existing conservative coefficients: 6 MiB fixed, sixteen node allowances of 16,384 bytes per tab, and 128 bytes per UTF-16 unit of retained keys and paths. It reserves three times its maximum charge for the live graph and two retired-graph allowances. This is empirical UI accounting, not a universal Chromium process-memory bound.

Metadata publication is serialized after precharge. Closing the last tab invalidates old publications and lets fresh work bypass delayed old replies. Outstanding old controllers remain counted until they unwind; zero release waits for both their lifetime and the tab DOM to end. Session guards prevent old callbacks from releasing a replacement core's share.

The PR records actual Windows private-byte samples at 16/64 tabs with accessibility off/on, opened/chooser/switched stages, exact committed head, clean native exit codes, full gate results and skips. Existing Raw and Rendered memory gates remain in force, with the workspace share identified independently.

## Remaining M2 work

This slice does not complete M2. Reopen closed tab, drag reorder, tab context actions and Back after local navigation remain. Workspace roots, splits, restore, quick open, command palette and settings follow separately.

The existing Mac last-window lifecycle still needs correction and platform verification: the brief requires the app to stay running after closing its empty window. Windows evidence does not establish Mac/Linux acceptance. Existing qualification debt and the $0 spending cap remain.
