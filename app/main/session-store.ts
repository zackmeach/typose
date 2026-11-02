import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { emptySession, sessionBounds, sessionWorkspace, type SessionBounds, type StoredSession } from '../shared/session'

const MAX_SESSION_BYTES = 1 << 20

/** Main owns this one private file. Invalid/oversized records never partially change a workspace. */
export class SessionStore {
  private state: StoredSession
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  constructor(private readonly file: string) {
    this.state = emptySession()
    try {
      if (statSync(file).size > MAX_SESSION_BYTES) return
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const workspace = sessionWorkspace(parsed)
      if (workspace) this.state = { ...workspace, window: sessionBounds((parsed as { window?: unknown }).window) }
    } catch { /* First launch or damaged file: keep the empty workspace. */ }
  }
  snapshot(): StoredSession { return structuredClone(this.state) }
  update(value: unknown): boolean {
    const workspace = sessionWorkspace(value)
    if (!workspace || Buffer.byteLength(JSON.stringify(workspace)) > MAX_SESSION_BYTES) return false
    this.state = { ...workspace, ...(this.state.window ? { window: this.state.window } : {}) }
    this.schedule()
    return true
  }
  bounds(value: SessionBounds): void {
    const bounds = sessionBounds(value)
    if (!bounds) return
    this.state = { ...this.state, window: bounds }
    this.schedule()
  }
  private schedule(): void {
    this.dirty = true
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 1000)
  }
  flush(): boolean {
    clearTimeout(this.timer)
    if (!this.dirty) return true
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temp, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, this.file)
      this.dirty = false
      return true
    } catch {
      try { unlinkSync(temp) } catch { /* No incomplete file survives a failed write. */ }
      return false
    }
  }
}
