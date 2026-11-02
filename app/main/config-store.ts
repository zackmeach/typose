import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_SETTINGS, settingValue, settingsValues, type ConfigParseProblem, type SettingsSnapshot, type Theme } from '../shared/settings'

export interface TomlCodec { configParse(source: string): string; configEdit(source: string, key: string, encoded: string): string }
const LIMIT = 256 << 10
const themeColors = ['canvas', 'surface', 'surface_raised', 'border', 'text', 'text_secondary', 'accent']
function read(file: string): string { if (!existsSync(file)) return ''; if (statSync(file).size > LIMIT) throw new Error('Config exceeds 256 KiB'); return readFileSync(file, 'utf8') }
/** The TOML editor's "TOML parse error at line L, column C" text, split into a position and its message. */
function parseProblem(error: string, path: string): ConfigParseProblem | undefined {
  const head = /^TOML parse error at line (\d+), column (\d+)\n/.exec(error)
  if (!head) return undefined
  const rest = error.slice(head[0].length).split('\n'), caret = rest.findIndex(line => /^\s*\|\s*\^/.test(line))
  const message = caret < 0 ? '' : rest.slice(caret + 1).join(' ').trim().replace(/\.$/, '')
  return { line: Number(head[1]), column: Number(head[2]), message: message || 'invalid TOML', path }
}
function revision(text: string): string { return createHash('sha256').update(text).digest('hex') }
function atomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`
  try { writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 }); renameSync(temp, file) }
  catch (error) { try { unlinkSync(temp) } catch { /* no incomplete output */ } throw error }
}
/** Only main supplies this directory; IPC accepts keys and a revision, never destinations. */
export class ConfigStore {
  private good = structuredClone(DEFAULT_SETTINGS)
  constructor(private readonly directory: string, private readonly codec: TomlCodec) {}
  snapshot(): SettingsSnapshot {
    let source = '', error: string | undefined, parse: ConfigParseProblem | undefined
    const file = join(this.directory, 'config.toml')
    try { source = read(file); this.good = settingsValues(JSON.parse(this.codec.configParse(source))) }
    catch (e) { error = e instanceof Error ? e.message : String(e); parse = parseProblem(error, file) }
    return { values: structuredClone(this.good), revision: revision(source), ...(error ? { error } : {}), ...(parse ? { parse } : {}), themes: this.themes() }
  }
  update(key: unknown, value: unknown, expected: unknown): SettingsSnapshot {
    if (typeof key !== 'string' || !settingValue(key, value) || typeof expected !== 'string') return { ...this.snapshot(), error: 'Invalid settings change' }
    try {
      const file = join(this.directory, 'config.toml'), source = read(file)
      const latest = settingsValues(JSON.parse(this.codec.configParse(source)))
      if (revision(source) !== expected) return { ...this.snapshot(), error: 'Config changed on disk. Values refreshed; apply your change again.' }
      const next = this.codec.configEdit(source, key, JSON.stringify(value))
      settingsValues(JSON.parse(this.codec.configParse(next)))
      mkdirSync(this.directory, { recursive: true }); atomic(file, next)
      this.good = { ...latest, [key]: value }
      return this.snapshot()
    } catch (e) { const now = this.snapshot(); return now.parse ? now : { ...now, error: e instanceof Error ? e.message : String(e) } }
  }
  exportTheme(name: unknown, tokens: unknown): SettingsSnapshot {
    try {
      if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/.test(name)) throw new Error('Use a theme name of 1–64 letters, numbers, spaces, underscores or hyphens')
      if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('Invalid theme')
      const allowed = new Set(['scheme', ...themeColors, 'ui_font', 'mono_font', 'ui_size', 'mono_size', 'density', 'frame'])
      if (Object.keys(tokens).some(key => !allowed.has(key))) throw new Error('Unknown theme token')
      const object = { version: 1, name, ...tokens }
      this.theme(name, object)
      let text = '# Typose theme\n'
      for (const [key, value] of Object.entries(object)) text = this.codec.configEdit(text, key, JSON.stringify(value))
      const directory = join(this.directory, 'themes'); mkdirSync(directory, { recursive: true })
      if (existsSync(join(directory, name + '.toml'))) throw new Error('A theme with this name already exists')
      atomic(join(directory, name + '.toml'), text)
      return this.snapshot()
    } catch (e) { return { ...this.snapshot(), error: e instanceof Error ? e.message : String(e) } }
  }
  private theme(id: string, raw: Record<string, unknown>): Theme {
    if (raw.version !== 1 || typeof raw.name !== 'string' || !['light', 'dark'].includes(String(raw.scheme))) throw new Error(`Invalid version or scheme in theme ${id}`)
    const tokens: Theme['tokens'] = {}
    for (const key of themeColors) { const value = raw[key]; if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid ${key} in theme ${id}`); tokens[key] = value }
    for (const key of ['ui_font', 'mono_font', 'ui_size', 'mono_size', 'density', 'frame']) if (raw[key] !== undefined) { if (!settingValue(key, raw[key])) throw new Error(`Invalid ${key} in theme ${id}`); tokens[key] = raw[key] as string | number }
    return { id, name: raw.name, scheme: raw.scheme as Theme['scheme'], tokens }
  }
  private themes(): Theme[] {
    const directory = join(this.directory, 'themes')
    if (!existsSync(directory)) return []
    const themes: Theme[] = []
    for (const name of readdirSync(directory).filter(name => name.endsWith('.toml')).slice(0, 64)) {
      try { themes.push(this.theme(name, JSON.parse(this.codec.configParse(read(join(directory, name)))))) } catch { /* malformed themes never become CSS */ }
    }
    return themes
  }
}
