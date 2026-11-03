import { DEFAULT_SETTINGS, type SettingKey, type SettingsSnapshot, type Theme } from '../shared/settings'
export const DARK_TOKENS = { canvas: '#111113', surface: '#1b1b1d', surface_raised: '#232326', border: '#26262a', text: '#ededed', text_secondary: '#a1a1a8', accent: '#8fb0ff' }
export const LIGHT_TOKENS = { canvas: '#f7f7f7', surface: '#ffffff', surface_raised: '#f0f0f2', border: '#dcdce0', text: '#202024', text_secondary: '#64646d', accent: '#285ac9' }
const BUILTIN: Theme[] = [{ id: 'Typose Dark', name: 'Typose Dark', scheme: 'dark', tokens: DARK_TOKENS }, { id: 'Typose Light', name: 'Typose Light', scheme: 'light', tokens: LIGHT_TOKENS }]
export class SettingsController {
  private state: SettingsSnapshot = { values: structuredClone(DEFAULT_SETTINGS), revision: '', themes: [] }
  private readonly listeners = new Set<() => void>()
  private serial = Promise.resolve()
  private readonly media = window.matchMedia('(prefers-color-scheme: dark)')
  constructor() { this.media.addEventListener('change', () => this.apply()) }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private accept(next: SettingsSnapshot): void { this.state = next; this.apply(); for (const listener of this.listeners) listener() }
  refresh = async (): Promise<void> => { this.accept(await window.typose.loadSettings()) }
  change = (key: SettingKey, value: unknown): void => {
    this.serial = this.serial.then(async () => this.accept(await window.typose.changeSetting(key, value, this.state.revision))).catch(error => this.accept({ ...this.state, error: String(error) }))
  }
  export = async (name: string): Promise<void> => {
    const theme = this.activeTheme(), settings = this.state.values
    const tokens = { ...theme.tokens, scheme: theme.scheme, ui_font: settings.ui_font, mono_font: settings.mono_font, ui_size: settings.ui_size, mono_size: settings.mono_size, density: settings.density, frame: settings.frame,
      ...(settings.accent ? { accent: settings.accent } : {}) }
    this.accept(await window.typose.exportTheme(name, tokens))
  }
  themes(): readonly Theme[] { return [...BUILTIN, ...this.state.themes] }
  selectTheme(scheme: 'light' | 'dark', theme: Theme): void {
    this.change(scheme === 'light' ? 'light_theme' : 'dark_theme', theme.id)
    for (const key of ['ui_font', 'mono_font', 'ui_size', 'mono_size', 'density', 'frame'] as const) if (theme.tokens[key] !== undefined) this.change(key, theme.tokens[key])
    this.change('accent', '')
  }
  activeTheme(): Theme {
    const settings = this.state.values, dark = settings.theme_mode === 'dark' || settings.theme_mode === 'system' && this.media.matches
    const selected = dark ? settings.dark_theme : settings.light_theme
    return this.themes().find(theme => (theme.id === selected || theme.name === selected) && theme.scheme === (dark ? 'dark' : 'light')) ?? BUILTIN[dark ? 0 : 1]
  }
  private apply(): void {
    const element = document.documentElement, settings = this.state.values, theme = this.activeTheme()
    element.dataset.theme = theme.scheme; element.dataset.frame = settings.frame; element.dataset.density = settings.density
    element.dataset.wrapLines = String(settings.wrap_lines)
    element.style.colorScheme = theme.scheme
    for (const [key, value] of Object.entries(theme.tokens)) if (['canvas', 'surface', 'surface_raised', 'border', 'text', 'text_secondary', 'accent'].includes(key))
      element.style.setProperty('--' + (key === 'text_secondary' ? 'text2' : key.replaceAll('_', '-')), String(value))
    if (settings.accent) element.style.setProperty('--accent', settings.accent)
    // Inter and JetBrains Mono are bundled and load late. style.css swaps them in only once they have loaded
    // (`data-fonts`), so a slow load never changes metrics later. Choosing one keeps that gated stack; another font leads it.
    const stack = (font: string, bundled: string, base: string) => font === bundled ? `var(${base})` : `${JSON.stringify(font)}, var(${base})`
    element.style.setProperty('--font-ui', stack(settings.ui_font, 'Inter', '--font-ui-base'))
    element.style.setProperty('--font-mono', stack(settings.mono_font, 'JetBrains Mono', '--font-mono-base'))
    element.style.setProperty('--ui-size', settings.ui_size + 'px'); element.style.setProperty('--mono-size', settings.mono_size + 'px')
    element.style.setProperty('--text-secondary', 'var(--text2)'); element.style.setProperty('--hairline', 'var(--border)'); element.style.setProperty('--guide', 'var(--border)')
    element.style.setProperty('--data-string', theme.scheme === 'dark' ? '#80bc92' : '#24653f')
    element.style.setProperty('--data-number', theme.scheme === 'dark' ? '#d9bc75' : '#775c11')
    element.style.setProperty('--data-boolean', theme.scheme === 'dark' ? '#bc9ade' : '#75409e')
    element.style.setProperty('--warning', theme.scheme === 'dark' ? '#d8ad60' : '#805c00')
    void window.typose.setChromeTheme(theme.scheme === 'dark', String(theme.tokens.canvas), String(theme.tokens.text))
  }
}
export function contrast(a: string, b: string): number {
  const luminance = (color: string) => { const rgb = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 }
  const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
export function fontAvailable(font: string): boolean {
  if (['Inter', 'JetBrains Mono', 'system-ui', 'sans-serif', 'monospace'].includes(font)) return true
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return false
  const sample = 'mmmmmmmmmmWWWWWWWWiiii0123456789'
  return ['monospace', 'serif', 'sans-serif'].some(fallback => {
    context.font = `72px ${fallback}`; const width = context.measureText(sample).width
    context.font = `72px ${JSON.stringify(font)}, ${fallback}`
    return context.measureText(sample).width !== width
  })
}
