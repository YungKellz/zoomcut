import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { bridgeSourcePath, buildMcpConfig, portableBridgePath, type McpConfigInput } from './mcpConfig'

const base: McpConfigInput = {
  packaged: true,
  portable: false,
  execPath: 'C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\ZoomCut\\ZoomCut.exe',
  resourcesPath: 'C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\ZoomCut\\resources',
  appPath: 'C:\\Users\\Ann Lee\\AppData\\Local\\Programs\\ZoomCut\\resources\\app.asar',
  userData: 'C:\\Users\\Ann Lee\\AppData\\Roaming\\zoomcut'
}

describe('buildMcpConfig', () => {
  it('runs the shipped bridge under the installed exe in Node mode', () => {
    const c = buildMcpConfig(base)
    expect(c.command).toBe(base.execPath)
    expect(c.bridge).toBe(join(base.resourcesPath, 'mcp', 'zoomcut-mcp.cjs'))
    expect(c.portable).toBe(false)
    expect(JSON.parse(c.json)).toEqual({
      mcpServers: { zoomcut: { command: base.execPath, args: [c.bridge], env: { ELECTRON_RUN_AS_NODE: '1' } } }
    })
    // the server name comes first: --env is variadic and would take "zoomcut" as one of its values
    expect(c.claudeCode).toBe(`claude mcp add --transport stdio zoomcut --env "ELECTRON_RUN_AS_NODE=1" -- "${base.execPath}" "${c.bridge}"`)
  })

  it('points a portable copy at the stable copy in userData and tells the bridge which exe to start', () => {
    const portableExe = 'D:\\Tools\\ZoomCut-Portable-0.4.1-x64.exe'
    const c = buildMcpConfig({ ...base, portable: true, portableExe, execPath: 'C:\\Temp\\1234\\ZoomCut.exe' })
    expect(c.portable).toBe(true)
    expect(c.command).toBe('node')
    expect(c.bridge).toBe(portableBridgePath(base.userData))
    expect(c.bridge).toBe(join(base.userData, 'mcp', 'zoomcut-mcp.cjs'))
    expect(JSON.parse(c.json).mcpServers.zoomcut).toEqual({ command: 'node', args: [c.bridge], env: { ZOOMCUT_EXE: portableExe } })
    expect(c.claudeCode).toBe(`claude mcp add --transport stdio zoomcut --env "ZOOMCUT_EXE=${portableExe}" -- node "${c.bridge}"`)
  })

  it('leaves the env out for a portable run that does not know its exe', () => {
    const c = buildMcpConfig({ ...base, portable: true })
    expect(JSON.parse(c.json).mcpServers.zoomcut).toEqual({ command: 'node', args: [c.bridge] })
    expect(c.claudeCode).toBe(`claude mcp add --transport stdio zoomcut -- node "${c.bridge}"`)
  })

  it('uses node and out/ when running from source', () => {
    const c = buildMcpConfig({ ...base, packaged: false, appPath: 'C:\\src\\zoomcut', execPath: 'C:\\src\\zoomcut\\node_modules\\electron\\dist\\electron.exe' })
    expect(c.command).toBe('node')
    expect(c.bridge).toBe(join('C:\\src\\zoomcut', 'out', 'mcp', 'zoomcut-mcp.cjs'))
    expect(JSON.parse(c.json).mcpServers.zoomcut).toEqual({ command: 'node', args: [c.bridge] })
    expect(c.claudeCode).toBe(`claude mcp add --transport stdio zoomcut -- node "${c.bridge}"`)
  })

  it('always quotes the paths, spaces or not (Git Bash eats the backslashes of a bare path)', () => {
    const c = buildMcpConfig({ ...base, execPath: 'C:\\ZoomCut\\ZoomCut.exe', resourcesPath: 'C:\\ZoomCut\\resources' })
    expect(c.claudeCode).toBe(
      `claude mcp add --transport stdio zoomcut --env "ELECTRON_RUN_AS_NODE=1" -- "C:\\ZoomCut\\ZoomCut.exe" "${join('C:\\ZoomCut\\resources', 'mcp', 'zoomcut-mcp.cjs')}"`
    )
    const dev = buildMcpConfig({ ...base, packaged: false, appPath: 'C:\\src\\zoomcut' })
    expect(dev.claudeCode).toBe(`claude mcp add --transport stdio zoomcut -- node "${join('C:\\src\\zoomcut', 'out', 'mcp', 'zoomcut-mcp.cjs')}"`)
  })

  describe('a ZOOMCUT_USER_DATA override', () => {
    it('is handed to the bridge next to the other variables, in the JSON and in the claude command', () => {
      const c = buildMcpConfig({ ...base, userDataOverride: 'D:\\zc' })
      expect(JSON.parse(c.json).mcpServers.zoomcut.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', ZOOMCUT_USER_DATA: 'D:\\zc' })
      expect(c.claudeCode).toBe(
        `claude mcp add --transport stdio zoomcut --env "ELECTRON_RUN_AS_NODE=1" --env "ZOOMCUT_USER_DATA=D:\\zc" -- "${base.execPath}" "${c.bridge}"`
      )
    })

    it('is the only variable for a source run, and joins ZOOMCUT_EXE for a portable one', () => {
      const dev = buildMcpConfig({ ...base, packaged: false, appPath: 'C:\\src\\zoomcut', userDataOverride: 'D:\\zc' })
      expect(JSON.parse(dev.json).mcpServers.zoomcut.env).toEqual({ ZOOMCUT_USER_DATA: 'D:\\zc' })
      expect(dev.claudeCode).toBe(`claude mcp add --transport stdio zoomcut --env "ZOOMCUT_USER_DATA=D:\\zc" -- node "${dev.bridge}"`)
      const portable = buildMcpConfig({ ...base, portable: true, portableExe: 'D:\\Z.exe', userDataOverride: 'D:\\zc' })
      expect(JSON.parse(portable.json).mcpServers.zoomcut.env).toEqual({ ZOOMCUT_EXE: 'D:\\Z.exe', ZOOMCUT_USER_DATA: 'D:\\zc' })
      expect(portable.claudeCode).toContain('--env "ZOOMCUT_EXE=D:\\Z.exe" --env "ZOOMCUT_USER_DATA=D:\\zc" --')
    })

    it('is left out when unset or empty, and loses a trailing separator that would escape the closing quote', () => {
      expect(JSON.parse(buildMcpConfig({ ...base, userDataOverride: '' }).json).mcpServers.zoomcut.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
      expect(JSON.parse(buildMcpConfig({ ...base, userDataOverride: 'D:\\zc\\' }).json).mcpServers.zoomcut.env.ZOOMCUT_USER_DATA).toBe('D:\\zc')
      expect(JSON.parse(buildMcpConfig({ ...base, userDataOverride: 'D:\\' }).json).mcpServers.zoomcut.env.ZOOMCUT_USER_DATA).toBe('D:\\')
    })
  })
})

describe('bridgeSourcePath', () => {
  it('is the extraResources copy once packaged, out/ otherwise', () => {
    expect(bridgeSourcePath({ packaged: true, resourcesPath: 'R', appPath: 'A' })).toBe(join('R', 'mcp', 'zoomcut-mcp.cjs'))
    expect(bridgeSourcePath({ packaged: false, resourcesPath: 'R', appPath: 'A' })).toBe(join('A', 'out', 'mcp', 'zoomcut-mcp.cjs'))
  })
})
