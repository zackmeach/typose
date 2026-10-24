// Windows' own view of the window, for the chrome's e2e tests (Windows only): its UI Automation tree (uia.ps1), what
// it answers Windows' hit test, and real mouse input (win-input.ps1). Points are in the page's CSS px.
import type { ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const powershell = (script: string, args: string[]): string =>
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, script), ...args], { encoding: 'utf8', timeout: 60_000 })

export interface Point {
  x: number
  y: number
}

/** An element of a UI Automation tree: its control type, name, localized type, keyboard focus and children. */
export interface UiaNode {
  type: string
  name: string
  localized: string
  focus: boolean
  /** ExpandCollapse's state, where the element has the pattern. */
  expand?: string
  children?: UiaNode[]
}

/** Every node of `tree`, depth first. */
export const uiaNodes = (tree: UiaNode): UiaNode[] => [tree, ...(tree.children ?? []).flatMap(uiaNodes)]

const handle = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE(0).toString())

/** The window's UI Automation tree, as Narrator reads it. */
export async function uiaTree(app: ElectronApplication): Promise<UiaNode> {
  return JSON.parse(powershell('uia.ps1', ['-hwnd', await handle(app)])) as UiaNode
}

/** Physical screen points, as `x,y;x,y`, for points in the page. */
const onScreen = (app: ElectronApplication, points: Point[]): Promise<string> =>
  app.evaluate(({ BrowserWindow, screen }, points) => {
    const w = BrowserWindow.getAllWindows()[0]
    const zoom = w.webContents.getZoomFactor()
    const c = w.getContentBounds()
    return points.map((p) => screen.dipToScreenPoint({ x: Math.round(c.x + p.x * zoom), y: Math.round(c.y + p.y * zoom) })).map((p) => `${p.x},${p.y}`).join(';')
  }, points)

/** Windows' hit-test answers (WM_NCHITTEST). */
export const HT = { CLIENT: 1, CAPTION: 2, MINBUTTON: 8, MAXBUTTON: 9, CLOSE: 20 }

const input = async (app: ElectronApplication, op: string, points: Point[]): Promise<unknown> =>
  JSON.parse(powershell('win-input.ps1', ['-op', op, '-hwnd', await handle(app), `-points:${await onScreen(app, points)}`]))

/** What the window answers Windows' hit test at each point: HT's codes. */
export const hitTest = (app: ElectronApplication, points: Point[]) => input(app, 'hittest', points) as Promise<number[]>

/** A double click at `point` as Windows delivers one to the window's frame: its hit test, then WM_NCLBUTTONDBLCLK. */
export const doubleClickMessage = (app: ElectronApplication, point: Point) => input(app, 'dblclick-message', [point])

/** Whether real input at `point` reaches this window; if not, what's in the way (the lock screen, say). */
export const reaches = (app: ElectronApplication, point: Point) => input(app, 'reach', [point]) as Promise<{ reached: boolean; under: string }>

/** Real mouse input, as a hand gives it: a drag from the first point to the second, or a double click at the first. */
export const realMouse = (app: ElectronApplication, op: 'drag' | 'dblclick', points: Point[]) => input(app, op, points)
