import { useEffect, useState, useSyncExternalStore } from 'react'
import { COMMANDS, commandShortcut } from '../shared/commands'
import type { SettingKey } from '../shared/settings'
import { contrast, fontAvailable, type SettingsController } from './settings-controller'
export type SettingsSection = 'Appearance' | 'Files' | 'Lenses' | 'Shortcuts'
export function SettingsPanel({ controller, initial = 'Appearance', openFile }: { controller: SettingsController; initial?: SettingsSection; openFile?(path: string): void }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot), values = snapshot.values
  const [section, setSection] = useState(initial), [themeName, setThemeName] = useState('')
  useEffect(() => { setSection(initial) }, [initial])
  useEffect(() => { void controller.refresh() }, [controller])
  const select = (label: string, key: SettingKey, options: readonly string[]) => <label>{label}<select aria-label={label} value={String(values[key])} onChange={event => controller.change(key, event.target.value)}>{options.map(option => <option key={option}>{option}</option>)}</select></label>
  const fontMissing = [values.ui_font, values.mono_font].filter(font => !fontAvailable(font))
  const accent = values.accent || String(controller.activeTheme().tokens.accent), background = String(controller.activeTheme().tokens.surface)
  return <div className="settings-panel" onFocus={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void controller.refresh() }}>
    <header className="card-header"><span>⚙ Settings / {section}</span></header>
    {snapshot.parse ? <div role="alert" className="banner config-banner"><span><strong>{"config.toml couldn't be parsed"}</strong>Line {snapshot.parse.line}, col {snapshot.parse.column}: {snapshot.parse.message}. Typose is using your last good settings.</span>
      {openFile ? <button onClick={() => openFile(snapshot.parse!.path)}>Open config.toml</button> : null}</div>
      : snapshot.error ? <div role="alert" className="banner">{snapshot.error}</div> : null}
    <nav aria-label="Settings sections">{(['Appearance', 'Files', 'Lenses', 'Shortcuts'] as const).map(name => <button key={name} aria-pressed={section === name} onClick={() => setSection(name)}>{name}</button>)}</nav>
    <div className="settings-content">
      {section === 'Appearance' ? <>
        <div className="settings-preview" aria-label="Live appearance preview"><h2>Readable, by design.</h2><p>Markdown · <a>local links</a> · <code>source code</code></p><table><tbody><tr><th>File</th><th>Rows</th></tr><tr><td>report.csv</td><td>1,024</td></tr></tbody></table><p><code>{'{ "role": "assistant", "text": "Local files stay local." }'}</code></p></div>
        <div role="group" aria-label="Theme mode" className="segmented"><span>Theme mode</span><div>{([['system', 'System'], ['light', 'Always light'], ['dark', 'Always dark']] as const).map(([mode, label]) =>
          <button key={mode} aria-pressed={values.theme_mode === mode} onClick={() => controller.change('theme_mode', mode)}>{label}</button>)}</div></div>
        <div className="theme-slots">{(['light', 'dark'] as const).map(scheme => <fieldset key={scheme}><legend>{scheme === 'light' ? 'Light theme' : 'Dark theme'}</legend>{controller.themes().filter(theme => theme.scheme === scheme).map(theme => <button key={theme.id} className="theme-sample" aria-pressed={values[scheme === 'light' ? 'light_theme' : 'dark_theme'] === theme.id} style={{ color: String(theme.tokens.text), background: String(theme.tokens.surface) }} onClick={() => controller.selectTheme(scheme, theme)}><b>Aa</b>{theme.name}</button>)}</fieldset>)}</div>
        {(['ui_font', 'mono_font'] as const).map(key => <label key={key}>{key === 'ui_font' ? 'Interface font' : 'Monospace font'}<input aria-label={key === 'ui_font' ? 'Interface font' : 'Monospace font'} key={values[key]} defaultValue={values[key]} onBlur={event => { if (event.target.value !== values[key]) controller.change(key, event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>)}
        {fontMissing.length ? <p role="status">Font unavailable: {fontMissing.join(', ')}. Using the bundled fallback.</p> : null}
        {(['ui_size', 'mono_size'] as const).map(key => <label key={key}>{key === 'ui_size' ? 'Interface size' : 'Monospace size'}<input aria-label={key === 'ui_size' ? 'Interface size' : 'Monospace size'} type="number" min="10" max="28" value={values[key]} onChange={event => controller.change(key, Number(event.target.value))} /></label>)}
        {select('Density', 'density', ['compact', 'default', 'spacious'])}{select('Frame', 'frame', ['card', 'flush'])}
        <label>Accent<input aria-label="Accent" type="color" value={accent} onChange={event => controller.change('accent', event.target.value)} /></label><button onClick={() => controller.change('accent', '')}>Reset accent</button>
        {contrast(accent, background) < 4.5 ? <p role="status">Accent contrast is below 4.5:1 against the card background.</p> : null}
        <form onSubmit={event => { event.preventDefault(); void controller.export(themeName) }}><label>Theme name<input aria-label="Theme name" value={themeName} onChange={event => setThemeName(event.target.value)} maxLength={64} /></label><button type="submit">Save as theme…</button></form>
        <p>Place version 1 TOML theme files in the themes folder beside config.toml, then focus Settings to refresh.</p>
      </> : null}
      {section === 'Files' ? <><label className="settings-check"><input aria-label="Show hidden files" type="checkbox" checked={values.show_hidden} onChange={event => controller.change('show_hidden', event.target.checked)} />Show hidden files</label>
        {select('CSV encoding fallback', 'encoding_fallback', ['windows-1252', 'utf-8'])}
        <label>Quick open excludes<input aria-label="Quick open excludes" key={values.excludes.join(',')} defaultValue={values.excludes.join(', ')} onBlur={event => controller.change('excludes', event.target.value.split(',').map(value => value.trim()).filter(Boolean))} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label><p>Names apply to files and folders at every depth. Symlinks and junctions are never followed.</p></> : null}
      {section === 'Lenses' ? <>{select('Markdown default lens', 'lens_md', ['rendered', 'raw'])}{select('CSV / TSV default lens', 'lens_csv', ['grid', 'raw'])}{select('JSON / JSONC default lens', 'lens_json', ['tree', 'raw'])}{select('JSONL default lens', 'lens_jsonl', ['rows', 'raw'])}{select('YAML default lens', 'lens_yaml', ['tree', 'raw'])}</> : null}
      {section === 'Shortcuts' ? <table className="shortcut-table"><tbody>{COMMANDS.filter(command => command.shortcut).map(command => <tr key={command.id}><td>{command.label}</td><td><kbd>{commandShortcut(command.shortcut, navigator.platform.startsWith('Mac'))}</kbd></td></tr>)}</tbody></table> : null}
    </div>
  </div>
}
