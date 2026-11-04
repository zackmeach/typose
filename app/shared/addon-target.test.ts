import { expect, it } from 'vitest'
import { addonTarget } from './addon-target'

it('names the napi-rs build of each supported platform and refuses any other', () => {
  expect(addonTarget('win32', 'x64')).toBe('win32-x64-msvc')
  expect(addonTarget('darwin', 'arm64')).toBe('darwin-arm64')
  expect(addonTarget('darwin', 'x64')).toBe('darwin-x64')
  expect(addonTarget('linux', 'x64')).toBe('linux-x64-gnu')
  expect(() => addonTarget('linux', 'arm64')).toThrow('no Typose core is built for linux-arm64')
})
