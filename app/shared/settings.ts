export const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next']
export interface Settings {
  theme_mode: 'system' | 'light' | 'dark'
  light_theme: string
  dark_theme: string
  ui_font: string
  mono_font: string
  ui_size: number
  mono_size: number
  density: 'compact' | 'default' | 'spacious'
  frame: 'card' | 'flush'
  accent: string
  show_hidden: boolean
  encoding_fallback: 'windows-1252' | 'utf-8'
  excludes: string[]
  lens_md: 'rendered' | 'raw'
  lens_csv: 'grid' | 'raw'
  lens_json: 'tree' | 'raw'
  lens_jsonl: 'rows' | 'raw'
  lens_yaml: 'tree' | 'raw'
  wrap_lines: boolean
}
export interface Theme { id: string; name: string; scheme: 'light' | 'dark'; tokens: Record<string, string | number> }
export interface ConfigParseProblem { line: number; column: number; message: string; path: string }
export interface SettingsSnapshot { values: Settings; revision: string; error?: string; parse?: ConfigParseProblem; themes: Theme[] }
export type SettingKey = keyof Settings
export const DEFAULT_SETTINGS: Settings = { theme_mode: 'system', light_theme: 'Typose Light', dark_theme: 'Typose Dark', ui_font: 'Inter', mono_font: 'JetBrains Mono',
  ui_size: 13, mono_size: 13, density: 'default', frame: 'card', accent: '', show_hidden: false, encoding_fallback: 'windows-1252', excludes: DEFAULT_EXCLUDES,
  lens_md: 'rendered', lens_csv: 'grid', lens_json: 'tree', lens_jsonl: 'rows', lens_yaml: 'tree', wrap_lines: false }
export function settingValue(key: string, value: unknown): boolean {
  if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return false
  if (key === 'ui_size' || key === 'mono_size') return typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 28
  if (key === 'show_hidden' || key === 'wrap_lines') return typeof value === 'boolean'
  if (key === 'excludes') return Array.isArray(value) && value.length <= 64 && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\\/\0]/.test(v))
  const enums: Record<string, string[]> = { theme_mode: ['system', 'light', 'dark'], density: ['compact', 'default', 'spacious'], frame: ['card', 'flush'], encoding_fallback: ['windows-1252', 'utf-8'],
    lens_md: ['rendered', 'raw'], lens_csv: ['grid', 'raw'], lens_json: ['tree', 'raw'], lens_jsonl: ['rows', 'raw'], lens_yaml: ['tree', 'raw'] }
  if (enums[key]) return typeof value === 'string' && enums[key].includes(value)
  if (key === 'accent') return typeof value === 'string' && (value === '' || /^#[0-9a-f]{6}$/i.test(value))
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\0\r\n;{}]/.test(value)
}
export function settingsValues(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Config must contain settings')
  const values = { ...DEFAULT_SETTINGS, excludes: [...DEFAULT_SETTINGS.excludes] }
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue
    if (!settingValue(key, value)) throw new Error(`Invalid value for ${key}`)
    Object.assign(values, { [key]: value })
  }
  return values
}
