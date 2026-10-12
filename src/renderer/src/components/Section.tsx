import type React from 'react'
import type { JSX } from 'react'

/**
 * A clearly bounded block of a side panel (inspector tabs, scenario/home cards): a header row with
 * the title (and optional actions on the right) above its own content, so it is obvious where
 * "Selected zoom" ends and "All zooms" begins.
 */
export function Section(props: {
  title?: React.ReactNode
  icon?: JSX.Element
  /** small controls shown at the right end of the header row */
  actions?: React.ReactNode
  className?: string
  children?: React.ReactNode
}): JSX.Element {
  const { title, icon, actions, className, children } = props
  return (
    <section className={'section' + (className ? ' ' + className : '')}>
      {(title !== undefined || actions !== undefined) && (
        <header className="section-head">
          <h3 className="section-title">
            {icon}
            {title}
          </h3>
          {actions !== undefined && <div className="section-actions">{actions}</div>}
        </header>
      )}
      <div className="section-body">{children}</div>
    </section>
  )
}
