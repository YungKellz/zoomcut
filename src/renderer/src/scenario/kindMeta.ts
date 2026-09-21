import type { ComponentType } from 'react'
import { Keyboard, Mouse, MouseLeft, MousePointerClick, MouseRight, Move, Scroll, Type } from 'lucide-react'
import type { ScenarioActionKind } from '@shared/types'
import type { TKey } from '../i18n/en'

/** Icon for each captured action kind - shared by the action list, the big preview and the timeline markers. */
export const KIND_ICON: Record<ScenarioActionKind, ComponentType<{ size?: number }>> = {
  click: MouseLeft,
  doubleClick: MousePointerClick,
  rightClick: MouseRight,
  middleClick: Mouse,
  drag: Move,
  scroll: Scroll,
  type: Type,
  key: Keyboard
}

/** i18n key for each kind's label: t(KIND_LABEL_KEY[action.kind]). */
export const KIND_LABEL_KEY: Record<ScenarioActionKind, TKey> = {
  click: 'scenario.kind.click',
  doubleClick: 'scenario.kind.doubleClick',
  rightClick: 'scenario.kind.rightClick',
  middleClick: 'scenario.kind.middleClick',
  drag: 'scenario.kind.drag',
  scroll: 'scenario.kind.scroll',
  type: 'scenario.kind.type',
  key: 'scenario.kind.key'
}
