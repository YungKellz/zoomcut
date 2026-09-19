import { useCallback } from 'react'
import { create } from 'zustand'
import type { Language } from '@shared/types'
import { en, type TKey } from './en'
import { ru } from './ru'

export type Lang = 'en' | 'ru'
export type { TKey }

const dicts: Record<Lang, Record<TKey, string>> = { en, ru }

export function systemLang(): Lang {
  const l = (navigator.language || '').toLowerCase()
  return l.startsWith('ru') ? 'ru' : 'en'
}

interface I18nState {
  lang: Lang
  setting: Language
  apply(setting: Language): void
}

export const useI18n = create<I18nState>((set) => ({
  lang: systemLang(),
  setting: 'system',
  apply: (setting) => set({ setting, lang: setting === 'system' ? systemLang() : setting })
}))

export function translate(lang: Lang, key: TKey, vars?: Record<string, string | number>): string {
  let s = dicts[lang][key] ?? en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  }
  return s
}

export type Translate = (key: TKey, vars?: Record<string, string | number>) => string

/** Hook returning the translate function for the current language. */
export function useT(): Translate {
  const lang = useI18n((s) => s.lang)
  return useCallback((key: TKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang])
}

/** Non-hook variant for code outside components. */
export function t(key: TKey, vars?: Record<string, string | number>): string {
  return translate(useI18n.getState().lang, key, vars)
}

export async function changeLanguage(setting: Language): Promise<void> {
  useI18n.getState().apply(setting)
  await window.zc.app.setSettings({ language: setting })
}
