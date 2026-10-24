import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import type { Command } from '../shared/protocol'

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
          <MenuItem id="exit" className="menu-item">
            {navigator.platform.startsWith('Linux') ? 'Quit' : 'Exit'}
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
