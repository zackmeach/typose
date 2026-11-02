import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import type { Command } from '../shared/protocol'
import { COMMANDS } from '../shared/commands'

/** Linux says Quit, and binds Ctrl+Q to it (brief §3.2, §7.2). */
export const LINUX = navigator.platform.startsWith('Linux')

/** Brief §3.2's ☰, on Windows and Linux, with M1's commands; the full command table is M2's. */
export function AppMenu({ run, enabled = () => true }: { run: (command: Command) => void; enabled?: (command: Command) => boolean }) {
  return (
    <MenuTrigger>
      <Button className="menu-button" aria-label="Menu">
        ☰
      </Button>
      <Popover className="menu-popover" placement="bottom start">
        <Menu className="menu" onAction={(key) => run(key as Command)}>
          {COMMANDS.filter(command => command.id !== 'browse').map(command => <MenuItem key={command.id} id={command.id} className="menu-item" isDisabled={!enabled(command.id)} data-clipboard-copy={command.id === 'copy' ? 'true' : undefined} data-handoff={command.id === 'show-in-folder' || command.id === 'open-default' ? 'true' : undefined}>
            {command.id === 'exit' && LINUX ? 'Quit' : command.label}
          </MenuItem>)}
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
