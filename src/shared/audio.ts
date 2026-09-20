import type { AudioClip, AudioClipKind, Project } from './types'

/** 'system' and 'mic' clips are recorded with the video and follow it through cuts (SOURCE time);
 * every other kind is an overlay placed in OUTPUT time (see AudioClip.start). */
export function isRecordedClip(clip: AudioClip): boolean {
  return clip.kind === 'system' || clip.kind === 'mic'
}

/** Absolute path of a clip's audio file, inside the project's recording folder. */
export function audioClipPath(project: Project, clip: AudioClip): string {
  return `${project.recording.dir}/${clip.file}`
}

/** Defaults for a newly created clip; callers still set id/kind/file/name/start/durationMs. */
export function newAudioClipDefaults(kind: AudioClipKind): Pick<AudioClip, 'volume' | 'muted' | 'loop' | 'fadeInMs' | 'fadeOutMs'> {
  return {
    volume: 1,
    muted: false,
    // only music beds loop by default (A2); everything else plays once
    loop: kind === 'music',
    fadeInMs: 0,
    fadeOutMs: 0
  }
}
