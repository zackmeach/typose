/** One document's share of the core's renderer reservation. Raw and retained Rendered trees coexist. */
import type { ViewRef } from '../../shared/protocol'

interface ReserveCore {
  call(method: 'reserve', params: { view: ViewRef; bytes: number } | { doc: number; gen: number; bytes: number }): Promise<boolean>
}

export interface ReloadReservation {
  generation: number
  epoch: number
  raw: number
  retiredTreeMax: number
  bytes: number
}

export class LensBudget {
  private active = true
  private epoch = 0
  private serial = Promise.resolve()
  private rendered = 0
  private grid = 0
  private transitioning = false

  constructor(
    private readonly core: ReserveCore,
    readonly session: number,
    readonly doc: number,
    private generation: number,
    private raw: number,
    private held: number,
    private treeMax = 0,
    private view?: ViewRef
  ) {}

  current(generation: number): boolean {
    return this.active && this.generation === generation
  }

  get rawReserved(): number {
    return this.raw
  }

  get retiredTreeMax(): number {
    return this.treeMax
  }

  snapshot() {
    return { generation: this.generation, raw: this.raw, rendered: this.rendered, grid: this.grid, retired: 2 * this.treeMax, total: this.held }
  }

  reserveRaw(generation: number, bytes: number): Promise<boolean> {
    return this.change(generation, 'raw', bytes)
  }

  reserveRendered(generation: number, bytes: number): Promise<boolean> {
    return this.change(generation, 'rendered', bytes)
  }

  /** Grid's bounded peak also pays its detached DOM across Raw/Grid switches on this exact view. */
  reserveGrid(generation: number, bytes: number): Promise<boolean> {
    return this.change(generation, 'grid', bytes)
  }

  /** A retained tree keeps its image leases when the lens switch asks for its base allowance again. */
  ensureRendered(generation: number, bytes: number): Promise<boolean> {
    return this.change(generation, 'rendered-min', bytes)
  }

  /** Image leases grow serially, so simultaneous metadata replies cannot overwrite one another's charge. */
  growRendered(generation: number, bytes: number): Promise<boolean> {
    return this.change(generation, 'rendered-add', bytes)
  }

  /** Freeze grants before the handoff snapshot: a late image grant must not allocate an uncounted retired Blob. */
  reloadReservation(raw: number): ReloadReservation {
    this.transitioning = true
    this.epoch++
    this.serial = Promise.resolve()
    const retiredTreeMax = Math.max(this.treeMax, this.rendered + this.grid)
    return { generation: this.generation, epoch: this.epoch, raw, retiredTreeMax, bytes: raw + 2 * retiredTreeMax }
  }

  /** A refused handoff keeps the old generation usable, without reviving any pre-snapshot grants. */
  cancelTransition(plan: ReloadReservation): void {
    if (!this.current(plan.generation) || plan.epoch !== this.epoch) return
    this.transitioning = false
  }

  /** The core's Reload already reserved `held`. Older queued work cannot update this generation's shares. */
  adopt(generation: number, held: number, plan: ReloadReservation, view?: ViewRef): boolean {
    if (!this.current(plan.generation) || plan.epoch !== this.epoch || generation <= this.generation) return false
    this.epoch++
    this.transitioning = false
    this.generation = generation
    this.view = view
    this.raw = plan.raw
    this.rendered = 0
    this.grid = 0
    this.treeMax = plan.retiredTreeMax
    this.held = held
    this.serial = Promise.resolve()
    return true
  }

  invalidate(): void {
    this.active = false
    this.epoch++
  }

  private change(generation: number, share: 'raw' | 'rendered' | 'rendered-min' | 'rendered-add' | 'grid', bytes: number): Promise<boolean> {
    const epoch = this.epoch
    const changed = this.serial.then(async () => {
      if (this.transitioning || !this.current(generation) || epoch !== this.epoch) return false
      const raw = share === 'raw' ? bytes : this.raw
      const rendered = share === 'rendered' ? bytes : share === 'rendered-min' ? Math.max(this.rendered, bytes) : share === 'rendered-add' ? this.rendered + bytes : this.rendered
      const grid = share === 'grid' ? Math.max(this.grid, bytes) : this.grid
      const total = raw + rendered + grid + 2 * this.treeMax
      const granted = total === this.held || await this.core.call('reserve', this.view ? { view: this.view, bytes: total } : { doc: this.doc, gen: generation, bytes: total }).catch(() => false)
      if (!granted || this.transitioning || !this.current(generation) || epoch !== this.epoch) return false
      this.raw = raw
      this.rendered = rendered
      this.grid = grid
      this.held = total
      return true
    })
    this.serial = changed.then(() => {})
    return changed
  }
}
