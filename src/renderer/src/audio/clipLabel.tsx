import type { JSX } from 'react'
import { FileAudio, Mic, Music, Volume2 } from 'lucide-react'
import type { AudioClip, AudioClipKind } from '@shared/types'
import type { Translate } from '../i18n'

/**
 * The fixed English name main writes into `clip.name` for a clip the user never renamed:
 * RecordingController.finishAudio stores "System audio" / "Microphone" for the recorded
 * tracks, and VoiceoverRecorder (Inspector.tsx) stores "Voiceover" the same way. clipLabel below
 * compares the live `clip.name` against this to tell "still the default" apart from "the user
 * renamed this clip" - only the latter is shown verbatim, the former shows the translated kind
 * label instead so a Russian UI does not display an English word.
 *
 * `music` and `file` clips have no single fixed default: a music clip's name is the picked
 * library track's title (MusicAndFilePicker) and a file's is the imported file's base name -
 * both are shown as-is regardless of language (they are not translatable UI copy), including for
 * an older project whose music clip still carries an English procedural-preset name (the removed
 * `src/renderer/src/audio/music.ts`) - nothing here depends on that id still meaning anything.
 * An EMPTY name (the user cleared the Name field) falls back to a translated kind label for
 * every kind, music/file included - see the `case 'music': case 'file'` branch below.
 */
export const DEFAULT_CLIP_NAMES: Record<AudioClipKind, string | null> = {
  system: 'System audio',
  mic: 'Microphone',
  voiceover: 'Voiceover',
  music: null,
  file: null
}

/** Display name for an audio clip: the clip's own name once it differs from its kind's default
 * (i.e. the user renamed it, or it never had a fixed default), otherwise the translated kind
 * label - used by both the Audio panel list (Inspector.tsx) and the timeline strips
 * (Timeline.tsx) so renaming a clip updates both places identically and live. */
export function clipLabel(t: Translate, clip: AudioClip): string {
  const def = DEFAULT_CLIP_NAMES[clip.kind]
  if (clip.name && clip.name !== def) return clip.name
  switch (clip.kind) {
    case 'system':
      return t('audio.kind.system')
    case 'mic':
      return t('audio.kind.mic')
    case 'voiceover':
      return t('audio.kind.voiceover')
    case 'music':
      // reached only when clip.name is empty (any non-empty name returns above, since music's
      // def is null) - an emptied Name field must not leave a blank row/region
      return t('audio.kind.music')
    case 'file':
      return t('audio.kind.file')
  }
}

/** Kind icon shown before the label in both the Audio panel list and the timeline strips. */
export function clipIcon(kind: AudioClipKind): JSX.Element {
  switch (kind) {
    case 'system':
      return <Volume2 size={14} />
    case 'mic':
    case 'voiceover':
      return <Mic size={14} />
    case 'music':
      return <Music size={14} />
    case 'file':
      return <FileAudio size={14} />
  }
}
