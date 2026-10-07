import type { JSX } from 'react'
import type React from 'react'
import { useRef, useState } from 'react'
import { formatSecondsValue, parseSecondsInput } from './format'
import { useI18n, useT } from '../i18n'

interface SecondsInputProps {
  className: string
  /** ms; null shows an empty field (e.g. "all pauses" while the pauses differ) */
  value: number | null
  ariaLabel: string
  onCommit: (ms: number) => void
}

/**
 * Seconds field with a local draft: the text the user is typing is never parsed on the fly
 * (a half-typed "1." or a momentarily empty field must not become a value) - it is committed on
 * blur / Enter only when it parses, Escape and an invalid draft revert. After a commit the field
 * shows the (possibly clamped) value the parent passes back.
 */
export function SecondsInput({ className, value, ariaLabel, onCommit }: SecondsInputProps): JSX.Element {
  const lang = useI18n((s) => s.lang)
  const [draft, setDraft] = useState<string | null>(null)
  const reverting = useRef(false)

  const shown = draft ?? (value === null ? '' : formatSecondsValue(value, lang))
  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      value={shown}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => {
        const ms = reverting.current ? null : parseSecondsInput(e.target.value)
        reverting.current = false
        setDraft(null)
        if (ms !== null) onCommit(ms)
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          reverting.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

export interface Preset {
  ms: number
  label: string
  title?: string
}

/** Row of one-click preset buttons; the one equal to the current value is highlighted. */
export function PresetButtons({ presets, current, onPick }: { presets: Preset[]; current: number | null; onPick: (ms: number) => void }): JSX.Element {
  return (
    <>
      {presets.map((p) => (
        <button
          key={p.label}
          type="button"
          className={'scenario-preset' + (p.ms === current ? ' active' : '')}
          title={p.title}
          onClick={() => onPick(p.ms)}
        >
          {p.label}
        </button>
      ))}
    </>
  )
}

/** "1 s" / "1,5 с" presets for a list of millisecond values. */
export function useSecondsPresets(values: readonly number[]): Preset[] {
  const t = useT()
  const lang = useI18n((s) => s.lang)
  return values.map((ms) => ({ ms, label: t('scenario.seconds', { n: formatSecondsValue(ms, lang) }) }))
}
