import type { Command } from './protocol'
export interface CommandDefinition { id: Command; label: string; shortcut?: string; document?: boolean }
/** Shared by native menu, renderer menu, palette and shortcut reference. */
export const COMMANDS: readonly CommandDefinition[] = [
  { id: 'open', label: 'Open file…', shortcut: 'Ctrl+O' },
  { id: 'browse', label: 'Browse…' },
  { id: 'open-folder', label: 'Open folder…' },
  { id: 'palette', label: 'Command palette', shortcut: 'Ctrl+K' },
  { id: 'settings', label: 'Settings' },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', shortcut: 'Ctrl+B' },
  { id: 'split-right', label: 'Split right', shortcut: 'Ctrl+\\' },
  { id: 'move-tab-right', label: 'Move tab right', document: true },
  { id: 'close-card', label: 'Close card' },
  { id: 'switch-lens', label: 'Switch lens', document: true },
  { id: 'wrap-lines', label: 'Wrap lines' },
  { id: 'zoom-in', label: 'Zoom in', shortcut: 'Ctrl+=' },
  { id: 'zoom-out', label: 'Zoom out', shortcut: 'Ctrl+-' },
  { id: 'zoom-reset', label: 'Reset zoom', shortcut: 'Ctrl+0' },
  { id: 'full-screen', label: 'Full screen', shortcut: 'F11' },
  { id: 'reload', label: 'Reload', shortcut: 'Ctrl+R', document: true },
  { id: 'refresh-folders', label: 'Refresh folders' },
  { id: 'find', label: 'Find in file…', shortcut: 'Ctrl+F', document: true },
  { id: 'find-next', label: 'Next match', shortcut: 'F3', document: true },
  { id: 'find-previous', label: 'Previous match', shortcut: 'Shift+F3', document: true },
  { id: 'go-to', label: 'Go to line / row…', shortcut: 'Ctrl+G', document: true },
  { id: 'copy', label: 'Copy selection', shortcut: 'Ctrl+C', document: true },
  { id: 'print', label: 'Print…', shortcut: 'Ctrl+P', document: true },
  { id: 'close-tab', label: 'Close tab', shortcut: 'Ctrl+W' },
  { id: 'reopen-tab', label: 'Reopen closed tab', shortcut: 'Ctrl+Shift+T' },
  { id: 'clear-closed', label: 'Clear recently closed tabs' },
  { id: 'theme-light', label: 'Theme: light' },
  { id: 'theme-dark', label: 'Theme: dark' },
  { id: 'theme-system', label: 'Theme: system' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'exit', label: 'Exit' }
]
export function commandShortcut(shortcut: string | undefined, mac = false): string { return shortcut?.replaceAll('Ctrl+', mac ? '⌘' : 'Ctrl+') ?? '' }
