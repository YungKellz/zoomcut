import { describe, expect, it } from 'vitest'
import { formatElapsed } from './format'

describe('formatElapsed', () => {
  it('formats seconds as zero-padded mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(5_000)).toBe('00:05')
    expect(formatElapsed(65_000)).toBe('01:05')
  })

  it('floors partial seconds instead of rounding', () => {
    expect(formatElapsed(1_999)).toBe('00:01')
  })

  it('clamps negative input to zero', () => {
    expect(formatElapsed(-500)).toBe('00:00')
  })

  it('does not pad minutes past two digits', () => {
    expect(formatElapsed(600_000)).toBe('10:00')
  })
})
