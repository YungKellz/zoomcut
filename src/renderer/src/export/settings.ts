import type { ExportFormat, ExportSettings, Project } from '@shared/types'
import { GIF_FPS_OPTIONS, MP4_FPS_OPTIONS } from '@shared/defaults'

/** Frame rates the export dialog offers for a format. */
export function exportFpsOptions(format: ExportFormat): number[] {
  return format === 'gif' ? GIF_FPS_OPTIONS : MP4_FPS_OPTIONS
}

/**
 * The settings after switching to `format`: the frame rate stays when the new format offers it,
 * and big GIFs get huge fast, so a large recording defaults to half size (`fullScaleWidth` = the
 * output width at 100 %).
 */
export function withExportFormat(settings: ExportSettings, format: ExportFormat, fullScaleWidth: number): ExportSettings {
  if (format === 'mp4') return { ...settings, format, fps: MP4_FPS_OPTIONS.includes(settings.fps) ? settings.fps : 30 }
  return {
    ...settings,
    format,
    fps: GIF_FPS_OPTIONS.includes(settings.fps) ? settings.fps : 15,
    scale: settings.scale === 1 && fullScaleWidth > 1400 ? 0.5 : settings.scale
  }
}

/** File name the export dialog suggests when the project has none saved: its name, stripped to plain characters. */
export function defaultExportFileName(project: Pick<Project, 'name' | 'export'>): string {
  return project.export.fileName || project.name.replace(/[^\w\- ]+/g, '').trim() || 'recording'
}
