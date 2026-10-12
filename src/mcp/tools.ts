/**
 * The MCP tools: one per RPC method of the ZoomCut app. The descriptions are the agent's only
 * manual, so they spell out units (source milliseconds, DIP relative to a display), what moves
 * the real mouse or records the real screen, and the order tools are usually called in. The
 * input schemas are the very zod objects the app validates against (shared/agentSchemas.ts).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { agentParamSchemas, type AgentMethodName } from '@shared/agentSchemas'
import { BridgeError } from './rpc'

/** what the tools need from the link to the app (ZoomCutClient in rpc.ts; a fake in tests) */
export interface RpcCaller {
  call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>
}

type Content = CallToolResult['content']

export interface ToolDef {
  name: string
  title: string
  description: string
  method: AgentMethodName
  annotations: ToolAnnotations
  /** how the RPC result becomes content; default: the result as indented JSON text */
  format?: (result: any) => Content
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }
const CHANGES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const DESTROYS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

const UNITS =
  'Units: times are milliseconds. Positions on a display are DIP (device-independent pixels, what Windows reports at the ' +
  "display's scaling) relative to the display's top-left corner. Positions inside a recording are fractions 0..1 of its frame."

export const SERVER_INSTRUCTIONS =
  'ZoomCut is a screen recorder and demo editor. Typical flow: get_status, then record the screen (start_recording / stop_recording) ' +
  'or let a scenario drive the machine while recording (create_scenario, record_scenario); look at the result with get_project, ' +
  'polish it with edit_project (cuts, zooms, texts, blurs, crop, frame), then export_project to an MP4 or GIF. ' +
  'Recording captures the REAL screen and scenario replay moves the REAL mouse and keyboard: the machine should be left alone while they run. ' +
  `${UNITS} In edit_project all times are SOURCE time (the original recording, before cuts).`

function text(value: string): Content[number] {
  return { type: 'text', text: value }
}

function json(result: unknown): Content {
  return [text(JSON.stringify(result, null, 2))]
}

interface Screenshot {
  displayId: number
  bounds: { x: number; y: number; width: number; height: number }
  scale: number
  mimeType: string
  data: string
}

function formatScreenshot(shot: Screenshot): Content {
  const w = Math.round(shot.bounds.width * shot.scale)
  const h = Math.round(shot.bounds.height * shot.scale)
  return [
    { type: 'image', data: shot.data, mimeType: shot.mimeType },
    text(
      `Screenshot of display ${shot.displayId}: ${w}x${h} px image of a ${shot.bounds.width}x${shot.bounds.height} DIP display ` +
        `(its top-left is at ${shot.bounds.x},${shot.bounds.y} on the virtual desktop). scale = ${shot.scale} image pixels per DIP. ` +
        `To act at image pixel (px, py), use x = px / ${shot.scale}, y = py / ${shot.scale} in create_scenario actions.`
    )
  ]
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_status',
    title: 'ZoomCut status',
    method: 'status',
    annotations: READ_ONLY,
    description:
      'Current state of ZoomCut: its version, which screen is showing (home, editor, scenario review, ...), whether a recording ' +
      '(idle, countdown, recording, processing) or a scenario capture is running, and the id of the recording open in the editor. ' +
      'Call it first, and again whenever something seems stuck. Starts ZoomCut if it is not running and the bridge knows where it is.'
  },
  {
    name: 'list_displays',
    title: 'List displays',
    method: 'displays.list',
    annotations: READ_ONLY,
    description:
      'List the displays (monitors): id, name, bounds on the virtual desktop, scale factor and which one is primary. ' +
      'Display ids are what start_recording, take_screenshot, create_scenario and start_scenario_capture accept. ' +
      'Coordinates in ZoomCut tools are DIP relative to a display\'s top-left corner, not physical pixels.'
  },
  {
    name: 'take_screenshot',
    title: 'Take a screenshot',
    method: 'screenshot',
    annotations: READ_ONLY,
    format: formatScreenshot,
    description:
      'Take a screenshot of a display right now and return it as an image together with its `scale` (image pixels per DIP). ' +
      'Use it to find where things are before writing a scenario: a point at image pixel (px, py) is x = px / scale, y = py / scale in ' +
      'create_scenario. Also useful to check what the screen looks like during or after a recording or replay. ZoomCut\'s own floating ' +
      'recorder bar and replay overlay are excluded from the picture. Default display: the last one used, else the primary one. ' +
      'The image is downscaled to maxWidth (default 1920) if the display is wider.'
  },
  {
    name: 'start_recording',
    title: 'Start recording',
    method: 'recording.start',
    annotations: CHANGES,
    description:
      'Start recording a display. This records the user\'s REAL screen: the ZoomCut window hides itself and a small floating bar ' +
      '(not recorded) shows the state. Returns after the ~3 second countdown, once recording is running; it keeps going until stop_recording ' +
      '(or cancel_recording). While it runs the machine can be used normally, for example by the user, or by an agent driving ' +
      'another app. Audio: `mic` and `systemAudio` (what the computer plays) default to the app\'s last choice, usually off. ' +
      'Fails with `busy` if a recording or scenario capture is already running.'
  },
  {
    name: 'stop_recording',
    title: 'Stop recording',
    method: 'recording.stop',
    annotations: CHANGES,
    description:
      'Stop the running recording and save it. Waits while ZoomCut converts and saves it (a few seconds, longer for long recordings) ' +
      'and returns { projectId, durationMs, warnings }. The new recording opens in the ZoomCut editor. Next: get_project to see ' +
      'what was recorded (including where the mouse clicked), edit_project to cut, zoom and annotate, export_project to render it. ' +
      'Fails with `not_found` if nothing is recording.'
  },
  {
    name: 'cancel_recording',
    title: 'Cancel recording',
    method: 'recording.cancel',
    annotations: DESTROYS,
    description:
      'Stop the running recording and throw it away - nothing is saved. Only possible during the countdown or while recording; once ' +
      'stop_recording has been called the recording is being saved (use delete_project afterwards).'
  },
  {
    name: 'list_projects',
    title: 'List recordings',
    method: 'projects.list',
    annotations: READ_ONLY,
    description:
      'List the saved recordings ("projects"), newest first: id, name, length, size, folder and the scenario each one was replayed from, if any. ' +
      'A project id is what get_project, edit_project, export_project and delete_project take.'
  },
  {
    name: 'get_project',
    title: 'Get a recording',
    method: 'projects.get',
    annotations: READ_ONLY,
    description:
      'Everything needed to plan edits to one recording: size, fps, sourceDurationMs (the recording as captured) and outputDurationMs ' +
      '(after cuts), the cuts, zooms, texts and blurs with their ids, crop, frame, cursor and export settings, the audio tracks, ' +
      'and `clicks` - where and when the mouse was clicked (t in source ms, x / y as fractions of the frame), which is where zooms and ' +
      'highlights usually belong (at most 500, thinned evenly beyond that). ' +
      'Times are SOURCE milliseconds; positions are fractions 0..1 of the whole recorded frame (before crop).'
  },
  {
    name: 'edit_project',
    title: 'Edit a recording',
    method: 'projects.edit',
    annotations: CHANGES,
    description:
      'Edit a recording with a list of operations, applied in order; if any is rejected, none is applied. Operations: rename; addCut / removeCut ' +
      '(remove a span of the video); addZoom / updateZoom / removeZoom ("follow" pans after the mouse, "fixed" zooms into a target); ' +
      'addText / updateText / removeText (timed captions); addBlur / removeBlur (hide a rectangle with blur or pixelation); setCrop; ' +
      'setFrame (padding, corner radius, background, shadow); setCursor (highlight, click ripples, follow-zoom smoothing). ' +
      'Times are SOURCE milliseconds (as in get_project, before cuts) and must lie inside the recording (0..sourceDurationMs). ' +
      'Positions and rectangles are fractions 0..1 of the recorded frame. Rules: minimum spans are zoom 200 ms, text 100 ms, blur 100 ms, cut 10 ms; ' +
      'zooms must not overlap each other (an overlap is rejected, never moved); colours must be opaque CSS colours; ' +
      'numbers outside the ranges in the schema are errors, not clamped; an update with no field to change is rejected; ' +
      'an unknown cut / zoom / text / blur id is `not_found`; cuts may not remove the whole recording. ' +
      'Returns the updated recording like get_project, so you can read the ids of what you added. ' +
      'If the recording is open in the ZoomCut editor it updates live and the whole call is one undo step (Ctrl+Z) for the user. ' +
      'A fixed zoom without a target aims at the centre; to aim it, use a click position from get_project.'
  },
  {
    name: 'export_project',
    title: 'Export a recording',
    method: 'projects.export',
    annotations: CHANGES,
    description:
      'Render a recording with all its edits to an MP4 or GIF file and return { outputPath, bytes }. It runs inside the ZoomCut app, so ' +
      'it takes about as long as the video (a minute or more for long ones) and the call waits for it. Everything is optional and defaults to ' +
      'the export settings saved in the project (set from the last export dialog); what you pass is saved back to the project. ' +
      'Frame rates: mp4 24 / 30 / 60, gif 10 / 12 / 15 / 20 / 25. `folder` must be an absolute path. An existing file is never overwritten ' +
      '("-2" is appended). GIFs have no audio; large GIFs get big fast, so prefer scale 0.5 and 10-15 fps.'
  },
  {
    name: 'delete_project',
    title: 'Delete a recording',
    method: 'projects.delete',
    annotations: DESTROYS,
    description:
      'Permanently delete a recording and its files (video, audio, edits). Cannot be undone. Refused with `busy` while the recording is open in ' +
      'the editor. Export first if the result is needed.'
  },
  {
    name: 'list_scenarios',
    title: 'List scenarios',
    method: 'scenarios.list',
    annotations: READ_ONLY,
    description:
      'List the saved scenarios, newest first: id, name, number of actions and replay length. A scenario is a script of mouse and keyboard ' +
      'actions ZoomCut can replay on the real screen while recording it (record_scenario).'
  },
  {
    name: 'get_scenario',
    title: 'Get a scenario',
    method: 'scenarios.get',
    annotations: READ_ONLY,
    description:
      'The actions of one scenario in the same form create_scenario takes: kind, display-relative DIP coordinates, text or key, and the ' +
      'effective durationMs and pauseMs of each action (and the total replay length). Works for scenarios captured by a person too.'
  },
  {
    name: 'create_scenario',
    title: 'Create a scenario',
    method: 'scenarios.create',
    annotations: CHANGES,
    description:
      'Write a scenario: a script of actions ZoomCut replays on the REAL screen with the real mouse and keyboard (see record_scenario). ' +
      'Actions: click / doubleClick / rightClick / middleClick (x, y, optional modifiers), drag (x, y to toX, toY), scroll (x, y, deltaY / deltaX in wheel ' +
      'notches, positive = down / right), type (text), key ("Enter", "Ctrl+S", "Alt+Tab", "F5"; "Win" alone opens Start). Coordinates are DIP relative ' +
      'to the display\'s top-left: find them with take_screenshot (image pixel / scale) and list_displays. Replay is strictly sequential: ' +
      'each action takes `durationMs` (the mouse glides there, then acts; defaults click/scroll 1000, drag 1500, key 500, typing 80 per character) ' +
      'and is followed by `pauseMs` of stillness (default 1500) - give slow things (page loads, animations) a longer pause so the recording shows them. ' +
      'Click a field before typing into it. Typed text goes to whatever has focus; no newlines or tabs (use key actions). ' +
      'The total may not exceed 10 minutes. Does not touch the machine yet: returns { scenarioId }. Then record_scenario.'
  },
  {
    name: 'delete_scenario',
    title: 'Delete a scenario',
    method: 'scenarios.delete',
    annotations: DESTROYS,
    description: 'Permanently delete a scenario (a saved script of mouse and keyboard actions). Recordings that were made from it are kept.'
  },
  {
    name: 'record_scenario',
    title: 'Record a scenario',
    method: 'scenarios.record',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      'Replay a scenario while recording the screen, and return { projectId, durationMs, warnings } when the replay has ended and the recording ' +
      'is saved. WARNING: this moves the REAL mouse and presses REAL keys on the user\'s machine, and records the real screen. Nobody should touch the ' +
      'mouse or keyboard until it returns; pressing Esc aborts it (the recording is then discarded and the call fails with `cancelled`). ' +
      'The windows and pages the scenario clicks must already be set up as the scenario expects. Takes as long as the scenario (plus a few ' +
      'seconds). The new recording opens in the ZoomCut editor. Audio flags work like start_recording.'
  },
  {
    name: 'start_scenario_capture',
    title: 'Start capturing a scenario',
    method: 'scenarios.captureStart',
    annotations: CHANGES,
    description:
      'Start capturing the clicks, drags, scrolls and keystrokes the USER performs on a display, to turn them into a scenario (the user must ' +
      'demonstrate it; the agent cannot click for them). Returns after the ~3 second countdown, once capturing runs. Tell the user to perform the steps, ' +
      'then call stop_scenario_capture (they can also press Ctrl+Alt+R or Stop on the floating bar - then just call stop_scenario_capture to get the id).'
  },
  {
    name: 'stop_scenario_capture',
    title: 'Stop capturing a scenario',
    method: 'scenarios.captureStop',
    annotations: CHANGES,
    description:
      'Stop the running scenario capture and save it. Returns { scenarioId, actions (count), durationMs }; read the actions with get_scenario, ' +
      'replay them with record_scenario. If nothing was captured the call fails with `cancelled`.'
  }
]

function errorResult(err: unknown): CallToolResult {
  const code = err instanceof BridgeError ? err.code : 'failed'
  const message = err instanceof Error ? err.message : String(err)
  return { isError: true, content: [text(`${code}: ${message}`)] }
}

export interface RegisterOptions {
  /** how often a long call tells the client it is still alive, when the client asked for progress; default 5000 */
  heartbeatMs?: number
}

/** Registers every tool on `server`; each call is one RPC to the app. */
export function registerTools(server: McpServer, rpc: RpcCaller, opts: RegisterOptions = {}): void {
  const heartbeatMs = opts.heartbeatMs ?? 5000

  const run = async (
    tool: ToolDef,
    args: unknown,
    extra: { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> }
  ): Promise<CallToolResult> => {
    // a long call (export, a recording being saved, a replay) would look hung to the client: tell it we are alive
    const token = extra._meta?.progressToken
    let ticks = 0
    const timer =
      token === undefined
        ? null
        : setInterval(() => {
            ticks++
            void extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: ticks, message: `ZoomCut is still working on ${tool.name} (${Math.round((ticks * heartbeatMs) / 1000)} s)` }
              })
              .catch(() => undefined)
          }, heartbeatMs)
    try {
      const result = await rpc.call(tool.method, args ?? {}, extra.signal)
      return { content: tool.format ? tool.format(result) : json(result) }
    } catch (err) {
      return errorResult(err)
    } finally {
      if (timer) clearInterval(timer)
    }
  }

  for (const tool of TOOLS) {
    const schema = agentParamSchemas[tool.method] as z.ZodObject
    const config = { title: tool.title, description: tool.description, annotations: { title: tool.title, ...tool.annotations } }
    if (Object.keys(schema.shape).length === 0) {
      // no parameters: a client may omit `arguments` altogether, which a strict object schema would refuse
      server.registerTool(tool.name, config, (extra) => run(tool, {}, extra))
    } else {
      server.registerTool(tool.name, { ...config, inputSchema: schema }, (args, extra) => run(tool, args, extra))
    }
  }
}
