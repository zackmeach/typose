// Plan PR 3 on the packaged, fused build (`npm run package` first): its fuses, driving it over CDP, and the NetLog.
import { expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { assertNetLog, fixture, test, visibleRows, waitIndexed, waitOpen } from './app'
import { PACKAGED, closePackaged, launchPackaged } from './packaged'

/** The fuse wire, read straight from the binary rather than through @electron/fuses, which wrote it. */
function fuseWire(binary: string): number[] {
  const bytes = readFileSync(binary)
  const at = bytes.indexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX') + 32 // the sentinel, then version and length
  expect(at).toBeGreaterThan(31)
  expect(bytes[at]).toBe(1) // wire version 1
  return [...bytes.subarray(at + 2, at + 2 + bytes[at + 1])]
}

test('the fuses read back as spec §7.1 lists them', () => {
  const wire = fuseWire(PACKAGED.fuses)
  const [off, on] = ['0'.charCodeAt(0), '1'.charCodeAt(0)]
  // Positions are @electron/fuses' FuseV1Options.
  expect({
    RunAsNode: wire[0],
    EnableNodeOptionsEnvironmentVariable: wire[2],
    EnableNodeCliInspectArguments: wire[3],
    EnableEmbeddedAsarIntegrityValidation: wire[4],
    OnlyLoadAppFromAsar: wire[5]
  }).toEqual({
    RunAsNode: off,
    EnableNodeOptionsEnvironmentVariable: off,
    EnableNodeCliInspectArguments: off,
    EnableEmbeddedAsarIntegrityValidation: on,
    OnlyLoadAppFromAsar: on
  })
})

test('the fused build listens on --remote-debugging-port=0, connectOverCDP attaches, and it opens a file', async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `packaged line ${i}`)
  const l = await launchPackaged({ cdp: true, file: fixture('packaged.txt', lines.join('\n')) })
  const win = l.page!
  expect(win.url()).toBe('typose://app/index.html')
  await waitOpen(win)
  expect(await win.title()).toBe('packaged.txt — Typose')
  expect((await visibleRows(win))[0]).toEqual({ line: 1, text: lines[0] })
  expect(await waitIndexed(win)).toBe(3000)
  expect(await closePackaged(l)).toEqual({ code: 0, signal: null })
})

// The forced hunspell fetch in netlog.e2e.ts needs main-process access, which the fused build doesn't give; that test
// runs the same main code on the dev layout.
test('the NetLog shows no network activity on the packaged build', async () => {
  const log = test.info().outputPath('netlog-packaged.json')
  const file = fixture('packaged-net.txt', Array.from({ length: 3000 }, (_, i) => `line ${i} café 語 😀`).join('\n'))
  const l = await launchPackaged({ cdp: true, netlog: log, file })
  await waitIndexed(l.page!)
  await l.page!.locator('.vl-scroller').focus()
  for (const key of ['PageDown', 'PageDown', 'Control+End', 'Control+Home', 'End']) await l.page!.keyboard.press(key)
  await closePackaged(l)
  expect(assertNetLog(log)).toContain('PASS')
})
