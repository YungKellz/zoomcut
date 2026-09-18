import type { ZcApi } from '../shared/api'

declare global {
  interface Window {
    zc: ZcApi
  }
}

export {}
