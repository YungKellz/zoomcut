/**
 * zod schemas of the agent RPC parameters, written once for both sides: the stdio bridge
 * (src/mcp) publishes them as the MCP tools' input schemas, the control server (src/main/agent)
 * validates every call against the same objects. The descriptions are the agent's manual for
 * each field, so they say units and coordinate spaces. Objects are strict: a misspelled field
 * is an error the agent can read, not a silently ignored option.
 */
import { z } from 'zod'
import type { AgentEditOp, AgentExportParams, AgentScenarioInput } from './agent'
import { AGENT_SCENARIO_MAX_ACTIONS, AGENT_SCROLL_MAX_NOTCHES } from './agentScenario'
import { KEY_CHORD_HELP } from './agentKeys'

/** ids of recordings and scenarios are timestamp folder names: "2026-01-02_03-04-05" or "...-2" */
export const ID_PATTERN = /^[0-9A-Za-z_-]+$/

const projectId = z.string().regex(ID_PATTERN).describe('Recording id, from list_projects, stop_recording or record_scenario')
const scenarioId = z.string().regex(ID_PATTERN).describe('Scenario id, from list_scenarios, create_scenario or stop_scenario_capture')
const displayId = z.number().int().describe('Display id from list_displays. Default: the last used display, else the primary one')

const ms = (what: string) => z.number().min(0).describe(what)
const normalized = (what: string) => z.number().min(0).max(1).describe(what)
const sourceStart = ms('Start, in SOURCE milliseconds (time in the original recording, before cuts)')
const sourceEnd = ms('End, in SOURCE milliseconds (exclusive; must be greater than start)')
const cssColor = z.string().min(1).max(64)

const textAnimation = z.enum(['none', 'fade', 'pop'])
const zoomMode = z.enum(['follow', 'fixed'])
const zoomScale = z.number().min(1.2).max(5).describe('Zoom factor, 1.2 to 5 (default 2)')
const zoomTarget = z
  .object({ x: normalized('Horizontal focus, 0 = left edge, 1 = right edge of the SOURCE frame'), y: normalized('Vertical focus, 0 = top, 1 = bottom of the SOURCE frame') })
  .strict()
  .describe('Focus point of a "fixed" zoom, normalized to the whole source frame (not the crop). Ignored by "follow" zooms')
const easeMs = (what: string) => z.number().min(0).max(1500).describe(what)
const textFields = {
  x: normalized('Horizontal centre of the text, 0..1 of the output frame (default 0.5)').optional(),
  y: normalized('Vertical centre of the text, 0..1 of the output frame (default 0.85, near the bottom)').optional(),
  fontSize: z.number().min(0.01).max(0.3).describe('Text height as a fraction of the output height (default 0.045; 0.02 is small, 0.1 is huge)').optional(),
  color: cssColor.describe('Text colour, any CSS colour (default "#ffffff")').optional(),
  background: cssColor.describe('Background box colour, any CSS colour (default "#000000", drawn at 60% opacity)').optional(),
  animation: textAnimation.describe('How the text appears and disappears (default "fade")').optional()
}

export const agentEditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename'), name: z.string().min(1).max(200).describe('New name of the recording') }).strict().describe('Rename the recording'),
  z
    .object({ op: z.literal('addCut'), start: sourceStart, end: sourceEnd })
    .strict()
    .describe('Remove the span [start, end) from the video. Everything after it moves earlier in the output; the cut can be restored with removeCut'),
  z.object({ op: z.literal('removeCut'), id: z.string().describe('Cut id from get_project') }).strict().describe('Restore a removed span'),
  z
    .object({
      op: z.literal('addZoom'),
      start: sourceStart,
      end: sourceEnd,
      mode: zoomMode.describe('"follow" pans smoothly after the recorded mouse; "fixed" zooms into the area around `target`'),
      scale: zoomScale.optional(),
      target: zoomTarget.optional(),
      easeInMs: easeMs('Zoom-in transition length in ms, 0..1500 (default 600)').optional(),
      easeOutMs: easeMs('Zoom-out transition length in ms, 0..1500 (default 500)').optional()
    })
    .strict()
    .describe('Zoom the camera in between start and end. Good places: around clicks listed by get_project. A "fixed" zoom needs `target` (default: the centre)'),
  z
    .object({
      op: z.literal('updateZoom'),
      id: z.string().describe('Zoom id from get_project'),
      start: sourceStart.optional(),
      end: sourceEnd.optional(),
      mode: zoomMode.optional(),
      scale: zoomScale.optional(),
      target: zoomTarget.optional()
    })
    .strict()
    .describe('Change fields of an existing zoom; omitted fields stay as they are'),
  z.object({ op: z.literal('removeZoom'), id: z.string().describe('Zoom id from get_project') }).strict().describe('Delete a zoom'),
  z
    .object({
      op: z.literal('addText'),
      start: sourceStart,
      end: sourceEnd,
      text: z.string().min(1).max(500).describe('The text to show'),
      ...textFields
    })
    .strict()
    .describe('Show a caption between start and end'),
  z
    .object({
      op: z.literal('updateText'),
      id: z.string().describe('Text id from get_project'),
      start: sourceStart.optional(),
      end: sourceEnd.optional(),
      text: z.string().min(1).max(500).optional(),
      ...textFields
    })
    .strict()
    .describe('Change fields of an existing text; omitted fields stay as they are'),
  z.object({ op: z.literal('removeText'), id: z.string().describe('Text id from get_project') }).strict().describe('Delete a text'),
  z
    .object({
      op: z.literal('addBlur'),
      start: sourceStart,
      end: sourceEnd,
      x: normalized('Left edge of the rectangle, 0..1 of the SOURCE frame'),
      y: normalized('Top edge of the rectangle, 0..1 of the SOURCE frame'),
      w: normalized('Width of the rectangle, 0..1 of the SOURCE frame'),
      h: normalized('Height of the rectangle, 0..1 of the SOURCE frame'),
      style: z.enum(['blur', 'pixelate']).describe('"blur" (default) or "pixelate"').optional(),
      strength: z.number().min(1).max(100).describe('Blur radius / pixel block size in px at 1080p (default 24)').optional()
    })
    .strict()
    .describe('Hide a rectangle (passwords, e-mails, ...) between start and end. It sticks to the picture and follows zooms. Locate the area on a take_screenshot or on the recording first'),
  z.object({ op: z.literal('removeBlur'), id: z.string().describe('Blur id from get_project') }).strict().describe('Delete a blur'),
  z
    .object({
      op: z.literal('setCrop'),
      x: normalized('Left edge, 0..1 of the source frame'),
      y: normalized('Top edge, 0..1 of the source frame'),
      w: normalized('Width, 0..1 of the source frame'),
      h: normalized('Height, 0..1 of the source frame')
    })
    .strict()
    .describe('Crop the whole video to a rectangle. { x: 0, y: 0, w: 1, h: 1 } removes the crop'),
  z
    .object({
      op: z.literal('setFrame'),
      padding: z.number().min(0).max(0.5).describe('Space around the video as a fraction of its height (0 = none)').optional(),
      cornerRadius: z.number().min(0).max(200).describe('Corner radius of the video in px at 1080p').optional(),
      background: cssColor
        .describe('Colour behind the video: a CSS colour, "gradient:dusk|ocean|sunset|mint|berry|slate", or "transparent" (GIF export only)')
        .optional(),
      shadow: z.boolean().describe('Drop shadow under the video').optional()
    })
    .strict()
    .describe('Style the frame around the video; omitted fields stay as they are'),
  z
    .object({
      op: z.literal('setCursor'),
      highlight: z.boolean().describe('Persistent highlight circle around the cursor').optional(),
      clicks: z.boolean().describe('Ripple animation on every recorded click').optional(),
      followSmoothing: z.number().min(0).max(1).describe('How lazily follow-zooms trail the cursor, 0..1 (default 0.6)').optional(),
      followDeadZone: z.number().min(0).max(0.3).describe('Distance the cursor may move from the centre before a follow-zoom pans, 0..0.3 (default 0.08)').optional()
    })
    .strict()
    .describe('Cursor highlight, click ripples and follow-zoom behaviour; omitted fields stay as they are')
])

const timing = {
  durationMs: z
    .number()
    .min(0)
    .describe('How long the action takes, ms. A mouse action first glides there, then happens near the end of this time. Raised to the kind minimum (click 200, double click 300, drag 500, key 150, type 25 per character, scroll about 300). Defaults: click and scroll 1000, drag 1500, key 500, type 80 per character')
    .optional(),
  pauseMs: z.number().min(0).max(60_000).describe('Stillness after the action, ms (default 1500). Replay is strictly sequential: each action starts when the previous one and its pause are over').optional()
}
const point = {
  x: z.number().describe('Horizontal position in DIP, relative to the left edge of the display (0,0 = its top-left corner). A take_screenshot image pixel divided by its `scale`'),
  y: z.number().describe('Vertical position in DIP, relative to the top edge of the display')
}

export const agentScenarioActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['click', 'doubleClick', 'rightClick', 'middleClick']),
      ...point,
      modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).describe('Keys held during the click, e.g. ["ctrl"]').optional(),
      ...timing
    })
    .strict()
    .describe('Move the mouse to (x, y) and click'),
  z
    .object({
      kind: z.literal('drag'),
      ...point,
      toX: z.number().describe('Where the button is released, DIP relative to the display'),
      toY: z.number().describe('Where the button is released, DIP relative to the display'),
      ...timing
    })
    .strict()
    .describe('Press the left button at (x, y), move to (toX, toY), release'),
  z
    .object({
      kind: z.literal('scroll'),
      ...point,
      deltaY: z.number().int().min(-AGENT_SCROLL_MAX_NOTCHES).max(AGENT_SCROLL_MAX_NOTCHES).describe('Wheel notches, positive = content scrolls down (default 3 when deltaX is not given either)').optional(),
      deltaX: z.number().int().min(-AGENT_SCROLL_MAX_NOTCHES).max(AGENT_SCROLL_MAX_NOTCHES).describe('Horizontal wheel notches, positive = right').optional(),
      ...timing
    })
    .strict()
    .describe('Move the mouse to (x, y) and turn the wheel'),
  z
    .object({
      kind: z.literal('type'),
      text: z.string().min(1).max(1000).describe('Text to type into whatever has focus (any language; typed as Unicode). No newlines or tabs: use key actions "Enter" / "Tab"'),
      ...timing
    })
    .strict()
    .describe('Type text, one character at a time, into the focused field'),
  z
    .object({
      kind: z.literal('key'),
      key: z.string().min(1).describe(`A key or shortcut, e.g. "Enter", "Escape", "Ctrl+S", "Ctrl+Shift+T", "Alt+Tab", "F5". ${KEY_CHORD_HELP}`),
      ...timing
    })
    .strict()
    .describe('Press a key or a shortcut chord')
])

export const agentScenarioInputSchema = z
  .object({
    name: z.string().min(1).max(120).describe('Scenario name shown on the home screen'),
    displayId: displayId.optional(),
    actions: z.array(agentScenarioActionSchema).min(1).max(AGENT_SCENARIO_MAX_ACTIONS).describe('Actions, replayed strictly one after another')
  })
  .strict()

const empty = z.object({}).strict()
const audioFlags = {
  mic: z.boolean().describe('Record the microphone (default: the app\'s last choice, usually off)').optional(),
  systemAudio: z.boolean().describe('Record system audio (what the computer plays; default: the app\'s last choice, usually off)').optional()
}

export const agentExportSchema = z
  .object({
    projectId,
    format: z.enum(['mp4', 'gif']).describe('Default: the format saved in the project (mp4 unless changed)').optional(),
    folder: z.string().min(1).describe('Absolute folder for the file, created if missing. Default: the project\'s export folder (the Videos folder unless changed)').optional(),
    fileName: z.string().min(1).max(200).describe('File name without extension. An existing file is never overwritten: " -2", " -3" is appended. Default: the project\'s export file name').optional(),
    fps: z.number().int().min(1).max(60).describe('Frames per second: 24, 30 or 60 for mp4; GIF is usually 10-25').optional(),
    scale: z.number().min(0.1).max(1).describe('Output size relative to the (cropped) recording: 1, 0.75 or 0.5').optional(),
    mp4Quality: z.enum(['low', 'medium', 'high', 'max']).describe('MP4 only').optional(),
    gifColors: z.union([z.literal(256), z.literal(128), z.literal(64), z.literal(32)]).describe('GIF palette size, 256 / 128 / 64 / 32').optional()
  })
  .strict()

/** parameters of every RPC method, by method name */
export const agentParamSchemas = {
  status: empty,
  'displays.list': empty,
  screenshot: z
    .object({
      displayId: displayId.optional(),
      maxWidth: z.number().int().min(160).max(7680).describe('Downscale the image to at most this width in pixels (default 1920)').optional()
    })
    .strict(),
  'projects.list': empty,
  'projects.get': z.object({ projectId }).strict(),
  'projects.delete': z.object({ projectId }).strict(),
  'projects.edit': z
    .object({ projectId, operations: z.array(agentEditOpSchema).min(1).max(200).describe('Edits, applied in order as one undo step') })
    .strict(),
  'projects.export': agentExportSchema,
  'scenarios.list': empty,
  'scenarios.get': z.object({ scenarioId }).strict(),
  'scenarios.create': agentScenarioInputSchema,
  'scenarios.delete': z.object({ scenarioId }).strict(),
  'scenarios.captureStart': z.object({ displayId: displayId.optional() }).strict(),
  'scenarios.captureStop': empty,
  'recording.start': z.object({ displayId: displayId.optional(), ...audioFlags }).strict(),
  'recording.stop': empty,
  'recording.cancel': empty,
  'scenarios.record': z.object({ scenarioId, ...audioFlags }).strict()
} as const

export type AgentMethodName = keyof typeof agentParamSchemas

// compile-time: what the schemas accept is what the contract types in agent.ts describe
type Assert<T extends true> = T
export type EditOpMatchesContract = Assert<z.infer<typeof agentEditOpSchema> extends AgentEditOp ? true : false>
export type ScenarioMatchesContract = Assert<z.infer<typeof agentScenarioInputSchema> extends AgentScenarioInput ? true : false>
export type ExportMatchesContract = Assert<z.infer<typeof agentExportSchema> extends AgentExportParams ? true : false>

/** "operations.2.end: Invalid input: expected number, received string; ..." – what an agent needs to fix its call */
export function formatZodError(error: z.ZodError): string {
  const text = error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(parameters)'
      return `${path}: ${issue.message}`
    })
    .join('; ')
  return text.length > 800 ? text.slice(0, 800) + '...' : text
}
