import type { PrintNode } from '../shared/protocol'

export type PrintUnit = 'line' | 'row'

export interface PrintPlan {
  unit: PrintUnit
  total: number
  current: number
  indexed: boolean
  totalPages: number
  allFits: boolean
}

export interface PrintRange {
  start: number
  end: number
}

export interface PrintPayload {
  blocks: PrintNode[]
  pages: number
  verify(signal: AbortSignal): Promise<boolean>
  release(): Promise<void>
}

export type { PrintNode } from '../shared/protocol'

export const PRINT_LINES_PER_PAGE = 60
