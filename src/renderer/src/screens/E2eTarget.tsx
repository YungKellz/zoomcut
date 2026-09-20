import type { JSX } from 'react'
import { useState } from 'react'

/**
 * Plain test-only page (hash `target`, opened only through `window.zc.e2e.openTarget`, itself
 * gated on ZOOMCUT_E2E): a button that counts clicks, a text input, a scrollable box and a
 * right-click handler, used by the B1/B2 e2e suites to verify the real capture/replay path
 * against known DOM state. English literals are fine here, this page is never shown to a user.
 */
export function E2eTarget(): JSX.Element {
  const [count, setCount] = useState(0)
  const [text, setText] = useState('')
  const [last, setLast] = useState('')

  return (
    <div
      style={{ minHeight: '100vh', padding: 24, fontFamily: 'sans-serif', background: '#1c1d21', color: '#eee' }}
      onContextMenu={(e) => {
        e.preventDefault()
        setLast('right')
      }}
    >
      <h1>ZoomCut e2e target</h1>

      <button id="hit" onClick={() => setCount((c) => c + 1)}>
        Hit me
      </button>
      <p>
        count: <span id="count">{count}</span>
      </p>

      <input id="text" value={text} onChange={(e) => setText(e.target.value)} />

      <p>
        last: <span id="last">{last}</span>
      </p>

      <div
        id="scroll"
        style={{ marginTop: 16, height: 200, width: 320, overflow: 'auto', border: '1px solid #666' }}
      >
        <div style={{ height: 2000, background: 'linear-gradient(#333, #7a7a7a)' }} />
      </div>
    </div>
  )
}
