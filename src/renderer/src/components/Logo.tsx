import type { JSX } from 'react'

/** The ZoomCut mark: gradient rounded square with a "Z". Same drawing as build/logo.svg. */
export function Logo({ size = 40 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="zc-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8cff" />
          <stop offset="1" stopColor="#b04fff" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#zc-logo-g)" />
      <path d="M72 72 H184 V98 L110 158 H184 V184 H72 V158 L146 98 H72 Z" fill="#fff" />
    </svg>
  )
}
