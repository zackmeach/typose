import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import type { Command } from '../shared/protocol'

/** Linux says Quit, and binds Ctrl+Q to it (brief §3.2, §7.2). */
export const LINUX = navigator.platform.startsWith('Linux')

/** Brief §3.2's ☰, on Windows and Linux, with M1's commands; the full command table is M2's. */
export function AppMenu({ run }: { run: (command: Command) => void }) {
  return (
    <MenuTrigger>
      <Button className="menu-button" aria-label="Menu">
        ☰
      </Button>
      <Popover className="menu-popover" placement="bottom start">
        <Menu className="menu" onAction={(key) => run(key as Command)}>
          <MenuItem id="open" className="menu-item">
            Open file…
          </MenuItem>
          <MenuItem id="reload" className="menu-item">
            Reload
          </MenuItem>
          <MenuItem id="close-tab" className="menu-item">
            Close tab
          </MenuItem>
          <MenuItem id="reopen-tab" className="menu-item">Reopen closed tab</MenuItem>
          <MenuItem id="clear-closed" className="menu-item">Clear recently closed tabs</MenuItem>
          <MenuItem id="exit" className="menu-item">
            {LINUX ? 'Quit' : 'Exit'}
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
