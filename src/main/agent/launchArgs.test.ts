import { describe, expect, it } from 'vitest'
import { AGENT_CONTROL_FLAG } from '@shared/agent'
import { agentControlRequested, hasAgentControlFlag, secondInstanceAction } from './launchArgs'

describe('agentControlRequested', () => {
  it('is the flag on the command line, or ZOOMCUT_AGENT_CONTROL=1', () => {
    expect(agentControlRequested(['ZoomCut.exe'], {})).toBe(false)
    expect(agentControlRequested(['ZoomCut.exe', AGENT_CONTROL_FLAG], {})).toBe(true)
    expect(agentControlRequested(['ZoomCut.exe'], { ZOOMCUT_AGENT_CONTROL: '1' })).toBe(true)
    expect(agentControlRequested(['ZoomCut.exe'], { ZOOMCUT_AGENT_CONTROL: '0' })).toBe(false)
    expect(agentControlRequested(['ZoomCut.exe'], { ZOOMCUT_AGENT_CONTROL: 'true' })).toBe(false)
  })

  it('tolerates the trailing space cmd leaves in `set X=1 && ZoomCut.exe`', () => {
    expect(agentControlRequested(['ZoomCut.exe'], { ZOOMCUT_AGENT_CONTROL: '1 ' })).toBe(true)
  })
})

describe('secondInstanceAction', () => {
  it('switches control on from the flag alone and leaves the window where it is', () => {
    expect(secondInstanceAction(['ZoomCut.exe', AGENT_CONTROL_FLAG], false)).toEqual({ enableAgentControl: true, showWindow: false })
    expect(secondInstanceAction(['ZoomCut.exe', AGENT_CONTROL_FLAG], true)).toEqual({ enableAgentControl: true, showWindow: false })
  })

  it('shows the window for an ordinary second launch, unless it is hidden for a recording, a capture or a replay', () => {
    expect(secondInstanceAction(['ZoomCut.exe'], false)).toEqual({ enableAgentControl: false, showWindow: true })
    expect(secondInstanceAction(['ZoomCut.exe'], true)).toEqual({ enableAgentControl: false, showWindow: false })
  })

  it('does not read the environment: a running copy only knows the second launch by its command line', () => {
    process.env['ZOOMCUT_AGENT_CONTROL'] = '1'
    try {
      expect(secondInstanceAction(['ZoomCut.exe'], false).enableAgentControl).toBe(false)
      expect(hasAgentControlFlag(['ZoomCut.exe'])).toBe(false)
    } finally {
      delete process.env['ZOOMCUT_AGENT_CONTROL']
    }
  })
})
