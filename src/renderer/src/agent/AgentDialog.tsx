import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import type { AgentMcpConfig } from '@shared/agent'
import { useT } from '../i18n'

interface Props {
  onClose(): void
}

/** The "AI agents (MCP)" dialog on Home: the ready-to-paste settings that connect an MCP client to this installation. */
export function AgentDialog({ onClose }: Props): JSX.Element {
  const t = useT()
  const [config, setConfig] = useState<AgentMcpConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.zc.agent
      .mcpConfig()
      .then((c) => alive && setConfig(c))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{t('agent.title')}</h2>
          <button className="btn btn-ghost" onClick={onClose} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <p className="muted">{t('agent.intro')}</p>
          {error && <div className="error-box">{t('agent.loadFailed', { error: error.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') })}</div>}
          {!config && !error && <p className="muted small">{t('agent.loading')}</p>}
          {config && (
            <>
              <ConfigBlock label={t('agent.json')} text={config.json} />
              <ConfigBlock label={t('agent.claudeCode')} text={config.claudeCode} />
              {config.portable && <p className="muted small">{t('agent.portableHint')}</p>}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A labelled, selectable snippet with a Copy button. */
function ConfigBlock({ label, text }: { label: string; text: string }): JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const pre = useRef<HTMLPreElement>(null)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    []
  )

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1800)
    } catch {
      // no clipboard access: select the text so Ctrl+C works
      const node = pre.current
      if (node) window.getSelection()?.selectAllChildren(node)
    }
  }

  return (
    <div className="agent-block">
      <div className="agent-block-head">
        <span className="field-label">{label}</span>
        <button className="btn btn-small" onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? t('agent.copied') : t('agent.copy')}
        </button>
      </div>
      <pre ref={pre} className="agent-code">
        {text}
      </pre>
    </div>
  )
}
