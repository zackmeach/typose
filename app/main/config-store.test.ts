import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { configEdit, configParse } from 'typose-node'
import { ConfigStore } from './config-store'

const directory = mkdtempSync(join(tmpdir(), 'typose-config-store-'))
const codec = { configEdit, configParse }
afterAll(() => rmSync(directory, { recursive: true, force: true }))
function store(name: string) { const path = join(directory, name); mkdirSync(path); return { path, file: join(path, 'config.toml'), store: new ConfigStore(path, codec) } }

it('preserves comments, spacing, unknown tables and quoted strings through the real TOML editor', () => {
  const { file, store: config } = store('format')
  const source = '# User comment\ntheme_mode  = "dark" # retained suffix\n\n[other]\nexample = "# not a comment"\n'
  writeFileSync(file, source)
  const result = config.update('theme_mode', 'light', config.snapshot().revision)
  expect(result.error).toBeUndefined()
  expect(result.values.theme_mode).toBe('light')
  expect(readFileSync(file, 'utf8')).toBe(source.replace('"dark"', '"light"'))
})

it('rejects stale edits without overwriting unrelated manual edits and refreshes current values', () => {
  const { file, store: config } = store('stale')
  writeFileSync(file, 'theme_mode = "dark"\n')
  const stale = config.snapshot().revision
  const manual = '# Manual edit\ntheme_mode = "light"\nshow_hidden = true\n'
  writeFileSync(file, manual)
  const rejected = config.update('theme_mode', 'system', stale)
  expect(rejected.error).toContain('changed on disk')
  expect(rejected.values).toMatchObject({ theme_mode: 'light', show_hidden: true })
  expect(readFileSync(file, 'utf8')).toBe(manual)
  expect(config.update('theme_mode', 'system', rejected.revision).error).toBeUndefined()
  expect(readFileSync(file, 'utf8')).toContain('show_hidden = true')
})

it('keeps the entire last good state on parse errors or invalid values and refuses writes', () => {
  const { file, store: config } = store('invalid')
  writeFileSync(file, 'theme_mode = "dark"\nshow_hidden = true\n')
  expect(config.snapshot().values.show_hidden).toBe(true)
  writeFileSync(file, 'theme_mode = [unfinished\n')
  expect(config.snapshot()).toMatchObject({ values: { theme_mode: 'dark', show_hidden: true }, error: expect.stringMatching(/line 1/),
    parse: { line: 1, column: expect.any(Number), message: expect.not.stringContaining('\n'), path: file } })
  expect(config.update('theme_mode', 'light', config.snapshot().revision).parse).toMatchObject({ line: 1 })
  expect(config.update('theme_mode', 'light', config.snapshot().revision).error).toBeTruthy()
  expect(readFileSync(file, 'utf8')).toBe('theme_mode = [unfinished\n')
  writeFileSync(file, 'theme_mode = "light"\nui_size = 999\n')
  expect(config.snapshot()).toMatchObject({ values: { theme_mode: 'dark', show_hidden: true }, error: 'Invalid value for ui_size' })
  expect(config.snapshot().parse).toBeUndefined()
})

it('theme export stays in its fixed directory and rejects traversal, duplicate names and unknown versions', () => {
  const { path, store: config } = store('themes')
  const tokens = { scheme: 'dark', canvas: '#111113', surface: '#1b1b1d', surface_raised: '#232326', border: '#26262a', text: '#ededed', text_secondary: '#a1a1a8', accent: '#8fb0ff' }
  expect(config.exportTheme('../outside', tokens).error).toBeTruthy()
  expect(config.exportTheme('New theme', tokens).themes).toHaveLength(1)
  expect(readFileSync(join(path, 'themes', 'New theme.toml'), 'utf8')).toContain('version = 1')
  expect(config.exportTheme('New theme', tokens).error).toContain('already exists')
  writeFileSync(join(path, 'themes', 'future.toml'), 'version = 99\nname = "Future"\nscheme = "dark"\n')
  expect(config.snapshot().themes).toHaveLength(1)
})
