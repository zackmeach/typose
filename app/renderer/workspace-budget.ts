interface WorkspaceCore {
  call(method: 'reserveWorkspace', params: { bytes: number }): Promise<boolean>
}

/** Reuse Rendered's conservative text/node coefficients for the retained pill and metadata graph. */
export function workspaceCharge(tabCount: number, pathUnits: number, extraBytes = 0): number {
  if (!Number.isSafeInteger(tabCount) || tabCount < 0 || !Number.isSafeInteger(pathUnits) || pathUnits < 0) return Infinity
  if (!Number.isSafeInteger(extraBytes) || extraBytes < 0) return Infinity
  if (tabCount === 0 && extraBytes === 0) return pathUnits === 0 ? 0 : Infinity
  // Sixteen nodes per pill include its controls, labels and collection bookkeeping; text also pays for store copies.
  const bytes = (6 << 20) + 16 * 16_384 * tabCount + 128 * pathUnits + extraBytes
  return Number.isSafeInteger(bytes) ? bytes : Infinity
}

/** One window's persistent tab UI, paid separately from its single selected lens in the same native reservation. */
export class WorkspaceBudget {
  private active = true
  private epoch = 0
  private serial = Promise.resolve()
  private sent = 0
  private acknowledged = 0
  private held = 0
  private peak: number
  private requestedPeak = 0
  /** Holds queued or awaiting their grant, cancelled ones included until they unwind. */
  private queued = 0

  constructor(private readonly core: WorkspaceCore, readonly session: number, previousPeakBytes = 0) {
    this.peak = previousPeakBytes
  }

  get reservationEpoch(): number { return this.epoch }

  snapshot() {
    // An intercepted/delayed response can make the last acknowledged amount older than the native amount.
    return { session: this.session, held: this.held, peakBytes: Math.max(this.peak, this.requestedPeak), settled: this.sent === this.acknowledged }
  }

  hold(tabCount: number, pathUnits: number, extraBytes = 0): Promise<boolean> {
    const charge = workspaceCharge(tabCount, pathUnits, extraBytes)
    if (!Number.isFinite(charge) || !this.active) return Promise.resolve(false)
    // A zero charge releases an idle bank only. A queued hold is another caller's open under way: releasing would cancel
    // it (the epoch moves) and it would report a full budget, as an early open did while the window restored. A held
    // allowance may be an open's grant whose tab isn't published yet. The release is left to releaseEmptyWorkspace,
    // which every path that empties the workspace ends in, and which waits until no work is pending.
    if (charge === 0) return this.queued || this.held ? Promise.resolve(true) : this.release()
    const epoch = this.epoch
    this.queued++
    const changed = this.serial.then(async () => {
      if (!this.active || epoch !== this.epoch) return false
      const peak = Math.max(this.peak, charge)
      const bytes = 3 * peak // live workspace and two retired graph allowances; monotonic until the last tab closes
      if (!Number.isSafeInteger(bytes)) return false
      this.requestedPeak = peak
      const granted = this.sent === this.acknowledged && bytes === this.held || await this.grant(bytes)
      if (epoch === this.epoch) this.requestedPeak = 0
      if (!granted || !this.active || epoch !== this.epoch) return false
      this.peak = peak
      return true
    }).finally(() => { this.queued-- })
    this.serial = changed.then(() => {})
    return changed
  }

  /** Call after the last tab's DOM/controllers are gone. A delayed old response cannot block a new open. */
  async release(): Promise<boolean> {
    if (!this.active) return false
    this.cancelPending()
    const epoch = this.epoch
    const sent = this.sent + 1
    const granted = await this.grant(0)
    const released = granted && this.active && epoch === this.epoch && sent === this.sent
    if (released) this.peak = 0
    return released
  }

  /** Invalidate prepublication work immediately, while the old DOM still retains its paid allowance until commit. */
  cancelPending(): void {
    // A reply can be delayed after native allocation. Its caller still retains the old path until it unwinds.
    this.peak = Math.max(this.peak, this.requestedPeak)
    this.requestedPeak = 0
    this.epoch++
    this.serial = Promise.resolve()
  }

  /** Core death owns native teardown. Never send an old session's release into its replacement. */
  invalidate(): void {
    this.active = false
    this.epoch++
    this.serial = Promise.resolve()
  }

  private async grant(bytes: number): Promise<boolean> {
    const sent = ++this.sent
    const granted = await this.core.call('reserveWorkspace', { bytes }).catch(() => false)
    if (granted && this.active && sent > this.acknowledged) {
      this.acknowledged = sent
      this.held = bytes
    }
    return granted
  }
}
