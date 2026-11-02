/** Independent acceptance list from brief §§3.2, 4.3 and 7.2, including the shipped document actions. */
export const menuLabels = (exit: string): string[] => [
  'Open file…', 'Open folder…', 'Command palette', 'Settings', 'Toggle sidebar', 'Split right', 'Move tab right', 'Close card',
  'Switch lens', 'Wrap lines', 'Zoom in', 'Zoom out', 'Reset zoom', 'Full screen', 'Reload', 'Refresh folders',
  'Find in file…', 'Next match', 'Previous match', 'Go to line / row…', 'Copy selection', 'Print…', 'Close tab', 'Reopen closed tab',
  'Clear recently closed tabs', 'Theme: light', 'Theme: dark', 'Theme: system', 'Keyboard shortcuts', exit
]
