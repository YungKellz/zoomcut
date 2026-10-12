import type { ComponentType } from 'react'
import { Keyboard, Mouse, MouseLeft, MousePointer2, MousePointerClick, MouseRight, Move, Scroll, Type } from 'lucide-react'
import type { ScenarioActionLabel } from '@shared/scenario'
import type { TKey } from '../i18n/en'

/** Icon for each captured action kind, and for 'hover' (a click switched to "position only") -
 * shared by the action list, the big preview and the timeline markers. Indexed by describeAction(a).kindKey. */
export const KIND_ICON: Record<ScenarioActionLabel, ComponentType<{ size?: number }>> = {
  click: MouseLeft,
  doubleClick: MousePointerClick,
  rightClick: MouseRight,
  middleClick: Mouse,
  drag: Move,
  scroll: Scroll,
  type: Type,
  key: Keyboard,
  hover: MousePointer2
}

/** i18n key for each kind's label: t(KIND_LABEL_KEY[describeAction(a).kindKey]). */
export const KIND_LABEL_KEY: Record<ScenarioActionLabel, TKey> = {
  click: 'scenario.kind.click',
  doubleClick: 'scenario.kind.doubleClick',
  rightClick: 'scenario.kind.rightClick',
  middleClick: 'scenario.kind.middleClick',
  drag: 'scenario.kind.drag',
  scroll: 'scenario.kind.scroll',
  type: 'scenario.kind.type',
  key: 'scenario.kind.key',
  hover: 'scenario.kind.hover'
}
