import { describe, expect, it } from 'vitest'
import type { AudioClip } from '@shared/types'
import { translate, type Lang, type TKey } from '../i18n'
import { DEFAULT_CLIP_NAMES, clipLabel } from './clipLabel'

function t(lang: Lang): (key: TKey, vars?: Record<string, string | number>) => string {
  return (key, vars) => translate(lang, key, vars)
}

function clip(patch: Partial<AudioClip>): AudioClip {
  return {
    id: 'audio_1',
    kind: 'mic',
    file: 'audio_1.m4a',
    name: 'Microphone',
    start: 0,
    durationMs: 5000,
    volume: 1,
    muted: false,
    loop: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...patch
  }
}

describe('clipLabel', () => {
  it('shows the translated kind label for the default (never renamed) name of system/mic/voiceover clips', () => {
    expect(clipLabel(t('en'), clip({ kind: 'system', name: DEFAULT_CLIP_NAMES.system! }))).toBe('System audio')
    expect(clipLabel(t('ru'), clip({ kind: 'system', name: DEFAULT_CLIP_NAMES.system! }))).toBe('Звук системы')
    expect(clipLabel(t('en'), clip({ kind: 'mic', name: DEFAULT_CLIP_NAMES.mic! }))).toBe('Microphone')
    expect(clipLabel(t('ru'), clip({ kind: 'mic', name: DEFAULT_CLIP_NAMES.mic! }))).toBe('Микрофон')
    expect(clipLabel(t('en'), clip({ kind: 'voiceover', name: DEFAULT_CLIP_NAMES.voiceover! }))).toBe('Voiceover')
    expect(clipLabel(t('ru'), clip({ kind: 'voiceover', name: DEFAULT_CLIP_NAMES.voiceover! }))).toBe('Озвучка')
  })

  it('shows a renamed clip\'s own name, unchanged, in every language', () => {
    const renamed = clip({ kind: 'mic', name: 'Interviewer' })
    expect(clipLabel(t('en'), renamed)).toBe('Interviewer')
    expect(clipLabel(t('ru'), renamed)).toBe('Interviewer')

    const renamedVoiceover = clip({ kind: 'voiceover', name: 'Narration take 2' })
    expect(clipLabel(t('en'), renamedVoiceover)).toBe('Narration take 2')
    expect(clipLabel(t('ru'), renamedVoiceover)).toBe('Narration take 2')
  })

  it('falls back to the translated kind label when the name is empty', () => {
    expect(clipLabel(t('en'), clip({ kind: 'mic', name: '' }))).toBe('Microphone')
    expect(clipLabel(t('ru'), clip({ kind: 'system', name: '' }))).toBe('Звук системы')
  })

  it('falls back to the translated kind label for an emptied music/file name too, instead of a blank label', () => {
    expect(clipLabel(t('en'), clip({ kind: 'music', name: '' }))).toBe('Music')
    expect(clipLabel(t('ru'), clip({ kind: 'music', name: '' }))).toBe('Музыка')
    expect(clipLabel(t('en'), clip({ kind: 'file', name: '' }))).toBe('Audio file')
    expect(clipLabel(t('ru'), clip({ kind: 'file', name: '' }))).toBe('Аудиофайл')
  })

  it('shows a music clip\'s library title as-is, in every language, since it has no fixed default', () => {
    const music = clip({ kind: 'music', name: 'Happy Whistling Ukulele', preset: 'happy-whistling-ukulele' })
    expect(clipLabel(t('en'), music)).toBe('Happy Whistling Ukulele')
    expect(clipLabel(t('ru'), music)).toBe('Happy Whistling Ukulele')
  })

  it('shows an old project\'s music clip name without crashing even when its preset id is unknown', () => {
    // pre-C2 projects stored the procedural preset's English name (see the removed audio/music.ts)
    const legacy = clip({ kind: 'music', name: 'Calm', preset: 'calm' })
    expect(clipLabel(t('en'), legacy)).toBe('Calm')
    expect(clipLabel(t('ru'), legacy)).toBe('Calm')
  })

  it('shows an imported file\'s own name as-is', () => {
    const file = clip({ kind: 'file', name: 'podcast-clip' })
    expect(clipLabel(t('en'), file)).toBe('podcast-clip')
  })
})
