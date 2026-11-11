import { useState } from 'react'
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import type { Command } from '../shared/protocol'
import { COMMANDS } from '../shared/commands'

/** Linux says Quit, and binds Ctrl+Q to it (brief §3.2, §7.2). */
export const LINUX = navigator.platform.startsWith('Linux')

/** Z79's names for revealing a file, per platform. */
export const SHOW_IN_FOLDER = navigator.platform.startsWith('Mac') ? 'Show in Finder' : LINUX ? 'Show in folder' : 'Show in Explorer'

/** Brief §3.2's ☰, on Windows and Linux, with M1's commands; the full command table is M2's. */
export function AppMenu({ run, enabled = () => true }: { run: (command: Command) => void; enabled?: (command: Command) => boolean }) {
  // Opening renders this again, so each item's state is read then: App doesn't render when a card's document opens,
  // and without this ☰ showed Reload disabled for up to 300 ms after one had.
  const [, setOpen] = useState(false)
  return (
    <MenuTrigger onOpenChange={setOpen}>
      <Button className="menu-button" aria-label="Menu">
        ☰
      </Button>
      <Popover className="menu-popover" placement="bottom start">
        <Menu className="menu" onAction={(key) => run(key as Command)}>
          {COMMANDS.filter(command => command.id !== 'browse').map(command => <MenuItem key={command.id} id={command.id} className="menu-item" isDisabled={!enabled(command.id)} data-clipboard-copy={command.id === 'copy' ? 'true' : undefined} data-handoff={command.id === 'show-in-folder' || command.id === 'open-default' ? 'true' : undefined}>
            {command.id === 'exit' && LINUX ? 'Quit' : command.id === 'show-in-folder' ? SHOW_IN_FOLDER : command.label}
          </MenuItem>)}
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}
