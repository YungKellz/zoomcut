import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_SETTINGS } from '@shared/defaults'
import { defaultExportFileName, exportFpsOptions, withExportFormat } from './settings'

describe('export settings helpers', () => {
  it('offers the frame rates of each format', () => {
    expect(exportFpsOptions('mp4')).toEqual([24, 30, 60])
    expect(exportFpsOptions('gif')).toEqual([10, 12, 15, 20, 25])
  })

  it('keeps the frame rate when the new format offers it, else uses the format default', () => {
    expect(withExportFormat({ ...DEFAULT_EXPORT_SETTINGS, fps: 60 }, 'gif', 800).fps).toBe(15)
    expect(withExportFormat({ ...DEFAULT_EXPORT_SETTINGS, fps: 10 }, 'mp4', 800).fps).toBe(30)
    expect(withExportFormat({ ...DEFAULT_EXPORT_SETTINGS, format: 'gif', fps: 15 }, 'mp4', 800).fps).toBe(30)
    expect(withExportFormat({ ...DEFAULT_EXPORT_SETTINGS, fps: 24 }, 'mp4', 800).fps).toBe(24)
    expect(withExportFormat({ ...DEFAULT_EXPORT_SETTINGS, fps: 20 }, 'gif', 800).fps).toBe(20)
  })

  it('defaults a big GIF to half size, but only from 100 %', () => {
    expect(withExportFormat(DEFAULT_EXPORT_SETTINGS, 'gif', 1920).scale).toBe(0.5)
    expect(withExportFormat(DEFAULT_EXPORT_SETTINGS, 'gif', 1400).scale).toBe(1)
    expect(withExportFormat({ ...DEFAULT_EXPORT_SETTINGS, scale: 0.75 }, 'gif', 1920).scale).toBe(0.75)
    expect(withExportFormat({ ...DEFAULT_EXPORT_SETTINGS, scale: 0.75 }, 'mp4', 1920).scale).toBe(0.75)
  })

  it('suggests a plain file name', () => {
    const base = { ...DEFAULT_EXPORT_SETTINGS }
    expect(defaultExportFileName({ name: 'My demo: part 1!', export: base })).toBe('My demo part 1')
    expect(defaultExportFileName({ name: 'Запись экрана', export: base })).toBe('recording')
    expect(defaultExportFileName({ name: 'x', export: { ...base, fileName: 'saved' } })).toBe('saved')
  })
})
