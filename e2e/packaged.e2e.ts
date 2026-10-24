// Plan PR 3 on the packaged, fused build (`npm run package` first): its fuses, what ships in its asar, driving it
// over CDP, the measurement hook's refusal, and the NetLog.
import { expect } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNetLog, fixture, lifecycle, test, visibleRows, waitIndexed, waitOpen } from './app'
import { PACKAGED, closePackaged, launchPackaged } from './packaged'

test('no test-hooks code ships: the asar holds none of its names, and the addon is the release one', () => {
  // The asar stores its files uncompressed, so a byte search sees every bundle in it.
  const asar = readFileSync(PACKAGED.asar)
  expect(asar.includes('TYPOSE_MARKS')).toBe(true) // the search works: the read-only hook's name is there
  for (const name of ['TYPOSE_TEST', 'delayMount', '__TEST_HOOKS__', 'typoseTest', 'debugStats', 'typose-node/hooks'])
    expect(asar.includes(name), name).toBe(false)
  // The addon is unpacked beside the asar (plan m8): the release build, without the test-hooks addon's calls, and
  // without the test-hooks addon itself.
  const addon = join(`${PACKAGED.asar}.unpacked`, 'node_modules', 'typose-node')
  const binary = readFileSync(join(addon, readdirSync(addon).find((f) => f.endsWith('.node'))!))
  expect(binary.includes('coreVersion')).toBe(true) // the search works: an export's name is there
  for (const name of ['debugStats', 'setReadDelay']) expect(binary.includes(name), name).toBe(false)
  expect(existsSync(join(addon, 'hooks'))).toBe(false)
})

// Spec §7.1: napi-rs's generated loader (typose-node/index.js, unpacked beside the asar) would load whatever
// NAPI_RS_NATIVE_LIBRARY_PATH names, or go looking for a WASI build. The core host requires its own binary instead.
test("the environment can't choose the core's addon: NAPI_RS_NATIVE_LIBRARY_PATH and NAPI_RS_FORCE_WASI are ignored", async () => {
  const env = { NAPI_RS_NATIVE_LIBRARY_PATH: join(tmpdir(), 'typose-no-such-addon.node'), NAPI_RS_FORCE_WASI: 'error' }
  const l = await launchPackaged({ cdp: true, env, file: fixture('packaged-loader.txt', 'one\ntwo\n') })
  await waitOpen(l.page!)
  expect((await visibleRows(l.page!))[0]).toEqual({ line: 1, text: 'one' })
  expect(await closePackaged(l)).toEqual({ code: 0, signal: null })
})

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
  // With TYPOSE_MARKS unset, as a user's launch is.
  const l = await launchPackaged({ cdp: true, marks: false, file: fixture('packaged.txt', lines.join('\n')) })
  const win = l.page!
  expect(win.url()).toBe('typose://app/index.html')
  await waitOpen(win)
  expect(await win.title()).toBe('packaged.txt — Typose')
  expect((await visibleRows(win))[0]).toEqual({ line: 1, text: lines[0] })
  expect(await waitIndexed(win)).toBe(3000)
  expect(await closePackaged(l)).toEqual({ code: 0, signal: null })
})

test('a TYPOSE_MARKS that names a directory is refused and logged, and the app still starts with its window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'typose-marks-dir-'))
  let kept: string | undefined // the profile closePackaged keeps, removed whether or not the expectations hold
  try {
    const l = await launchPackaged({ cdp: true, env: { TYPOSE_MARKS: dir } })
    await expect(l.page!.locator('.open-button')).toBeVisible() // the window, its page and the core are up
    const log = lifecycle(l.userData)
    kept = l.userData
    expect(await closePackaged(l, true)).toEqual({ code: 0, signal: null })
    expect(log.find((r) => r.event === 'hook-refused')).toMatchObject({ hook: 'TYPOSE_MARKS', reason: expect.stringMatching(/regular file/) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (kept) rmSync(kept, { recursive: true, force: true })
  }
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
