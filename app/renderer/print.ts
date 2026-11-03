import type { PrintNode } from '../shared/protocol'

export interface PrintPlan {
  unit: 'line' | 'row'
  total: number
  current: number
  indexed: boolean
  totalPages: number
  allFits: boolean
}

export interface PrintPayload {
  blocks: PrintNode[]
  pages: number
  verify(signal: AbortSignal): Promise<boolean>
  release(): Promise<void>
}

export const PRINT_LINES_PER_PAGE = 60
