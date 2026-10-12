/**
 * zod schemas of the agent RPC parameters, written once for both sides: the stdio bridge
 * (src/mcp) publishes them as the MCP tools' input schemas, the control server (src/main/agent)
 * validates every call against the same objects. The descriptions are the agent's manual for
 * each field, so they say units, coordinate spaces and the ranges that are really accepted:
 * the limits here are the editor's own, and a value outside them is an error the agent can
 * read, never a silently clamped number. Objects are strict: a misspelled field is an error too.
 * What only the project can tell (an id that exists, a time inside the recording, zooms that do
 * not overlap) is checked by the renderer's applyAgentEdits, which says so in its error.
 */
import { z } from 'zod'
import type { AgentEditOp, AgentExportParams, AgentScenarioInput } from './agent'
import { AGENT_SCENARIO_MAX_ACTIONS, AGENT_SCROLL_MAX_NOTCHES, AGENT_TYPE_MAX_CHARS } from './agentScenario'
import { KEY_CHORD_HELP } from './agentKeys'
import { GIF_FPS_OPTIONS, GRADIENT_PRESETS, MP4_FPS_OPTIONS, SCENARIO_MAX_MS } from './defaults'
import { DURATION_MAX_MS, PAUSE_MAX_MS, TYPE_MIN_MS_PER_CHAR, graphemes } from './scenario'

/** ids of recordings and scenarios are timestamp folder names: "2026-01-02_03-04-05" or "...-2" */
export const ID_PATTERN = /^[0-9A-Za-z_-]+$/

/** shortest spans the editor allows, ms (cuts: shorter selections are ignored) */
export const AGENT_MIN_SPAN_MS = { cut: 10, zoom: 200, text: 100, blur: 100 } as const
/** smallest blur / crop rectangle, a fraction of the recording */
const MIN_BLUR_SIZE = 0.01
const MIN_CROP_SIZE = 0.05
export const MAX_EDIT_OPERATIONS = 500

const projectId = z.string().regex(ID_PATTERN).describe('Recording id, from list_projects, stop_recording or record_scenario')
const scenarioId = z.string().regex(ID_PATTERN).describe('Scenario id, from list_scenarios, create_scenario or stop_scenario_capture')
const displayId = z.number().int().describe('Display id from list_displays. Default: the last used display, else the primary one')

const normalized = (what: string) => z.number().min(0).max(1).describe(what)
const sourceStart = z.number().min(0).describe('Start, in SOURCE milliseconds (time in the original recording, before cuts; 0 = the first frame)')
const sourceEnd = z.number().min(0).describe('End, in SOURCE milliseconds (exclusive). Must not exceed the recording length (sourceDurationMs in get_project)')
const existingId = (what: string) => z.string().min(1).describe(`Id of the ${what}, from get_project. An unknown id is a not_found error`)

// ---- colours: opaque CSS only (the editor stores "#rrggbb"; transparency is not supported) ----
const OPAQUE_COLOR_HELP =
  'an opaque CSS colour: "#rrggbb", "#rgb", a colour name such as "white", "rgb(10, 20, 30)" or "hsl(200, 80%, 50%)". ' +
  'Colours with transparency (#rrggbbaa, rgba(), hsla(), "transparent") are rejected'

/** Syntax check only (no DOM here); the renderer parses the colour for real and rejects what is not one. */
export function isPlausibleOpaqueColor(value: string): boolean {
  const s = value.trim().toLowerCase()
  if (s.startsWith('#')) return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(s)
  if (/^(?:rgb|hsl)\(/.test(s)) {
    // exactly three components, no alpha ("/ 50%", a fourth number)
    return /^(?:rgb|hsl)\(\s*[^,/\s)]+(?:\s*,\s*[^,/\s)]+){2}\s*\)$/.test(s) || /^(?:rgb|hsl)\(\s*[^,/\s)]+(?:\s+[^,/\s)]+){2}\s*\)$/.test(s)
  }
  return /^[a-z]+$/.test(s) && s !== 'transparent'
}
const cssColor = z.string().min(1).max(64).refine(isPlausibleOpaqueColor, `must be ${OPAQUE_COLOR_HELP}`)

const textAnimation = z.enum(['none', 'fade', 'pop'])
const zoomMode = z.enum(['follow', 'fixed'])
const zoomScale = z.number().min(1.2).max(5).describe('Zoom factor, 1.2 to 5 (default 2)')
const zoomTarget = z
  .object({ x: normalized('Horizontal focus, 0 = left edge, 1 = right edge of the SOURCE frame'), y: normalized('Vertical focus, 0 = top, 1 = bottom of the SOURCE frame') })
  .strict()
  .describe('Focus point of a "fixed" zoom, normalized to the whole source frame (not the crop). A fixed zoom without a target aims at the centre. Ignored by "follow" zooms')
const easeMs = (what: string) => z.number().min(0).max(1500).describe(what)
const textStyleFields = {
  x: normalized('Horizontal centre of the text, 0..1 of the output frame (default 0.5)').optional(),
  y: normalized('Vertical centre of the text, 0..1 of the output frame (default 0.85, near the bottom)').optional(),
  fontSize: z.number().min(0.02).max(0.14).describe('Text height as a fraction of the output height, 0.02 to 0.14 (default 0.045; 0.02 is small, 0.1 is large)').optional(),
  color: cssColor.describe(`Text colour, ${OPAQUE_COLOR_HELP} (default "#ffffff")`).optional(),
  background: cssColor.describe(`Background box colour, ${OPAQUE_COLOR_HELP}. Default "#000000"; the box is always drawn at 60% opacity`).optional(),
  animation: textAnimation.describe('How the text appears and disappears (default "fade")').optional()
}
const textContent = z.string().max(500).refine((s) => s.trim() !== '', 'must not be empty').describe('The text to show, at most 500 characters')

const spanLength = (min: number) => (o: { start?: number; end?: number }): boolean =>
  o.start === undefined || o.end === undefined || Math.round(o.end) - Math.round(o.start) >= min
const spanMessage = (what: string, min: number) => `end must be at least ${min} ms after start (the shortest ${what} the editor allows)`
/** an update that names no field to change does nothing, which is almost certainly a mistake */
const changesSomething = (o: object): boolean => Object.entries(o).some(([key, value]) => key !== 'op' && key !== 'id' && value !== undefined)
const NOTHING_TO_CHANGE = 'give at least one field to change'
/** x + w and y + h stay inside the frame; w and h are not tiny */
const rectFits = (min: number) => (r: { x: number; y: number; w: number; h: number }): boolean =>
  r.w >= min && r.h >= min && r.x + r.w <= 1 + 1e-6 && r.y + r.h <= 1 + 1e-6
const rectMessage = (min: number) => `w and h must be at least ${min}, and x + w and y + h at most 1 (the rectangle must stay inside the frame)`

const frameBackground = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (s) => s.trim() === 'transparent' || Object.hasOwn(GRADIENT_PRESETS, s.trim()) || isPlausibleOpaqueColor(s),
    `must be ${OPAQUE_COLOR_HELP}; or one of ${Object.keys(GRADIENT_PRESETS).join(', ')}; or "transparent" (GIF export only)`
  )

export const agentEditOpSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('rename'), name: z.string().max(200).refine((s) => s.trim() !== '', 'must not be empty').describe('New name of the recording, at most 200 characters') })
    .strict()
    .describe('Rename the recording'),
  z
    .object({ op: z.literal('addCut'), start: sourceStart, end: sourceEnd })
    .strict()
    .refine(spanLength(AGENT_MIN_SPAN_MS.cut), spanMessage('cut', AGENT_MIN_SPAN_MS.cut))
    .describe('Remove the span [start, end) from the video, at least 10 ms long and inside the recording. Everything after it moves earlier in the output; the cut can be restored with removeCut. Cuts that would remove the whole recording are rejected'),
  z.object({ op: z.literal('removeCut'), id: existingId('cut') }).strict().describe('Restore a removed span'),
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
    .refine(spanLength(AGENT_MIN_SPAN_MS.zoom), spanMessage('zoom', AGENT_MIN_SPAN_MS.zoom))
    .describe('Zoom the camera in between start and end (at least 200 ms, inside the recording). Zooms must not overlap another zoom: an overlap is rejected, nothing is moved for you. Good places: around clicks listed by get_project. A "fixed" zoom without `target` aims at the centre'),
  z
    .object({
      op: z.literal('updateZoom'),
      id: existingId('zoom'),
      start: sourceStart.optional(),
      end: sourceEnd.optional(),
      mode: zoomMode.optional(),
      scale: zoomScale.optional(),
      target: zoomTarget.optional()
    })
    .strict()
    .refine(changesSomething, NOTHING_TO_CHANGE)
    .refine(spanLength(AGENT_MIN_SPAN_MS.zoom), spanMessage('zoom', AGENT_MIN_SPAN_MS.zoom))
    .describe('Change fields of an existing zoom; omitted fields stay as they are, at least one must be given. The result must still be at least 200 ms and must not overlap another zoom'),
  z.object({ op: z.literal('removeZoom'), id: existingId('zoom') }).strict().describe('Delete a zoom'),
  z
    .object({
      op: z.literal('addText'),
      start: sourceStart,
      end: sourceEnd,
      text: textContent,
      ...textStyleFields
    })
    .strict()
    .refine(spanLength(AGENT_MIN_SPAN_MS.text), spanMessage('text', AGENT_MIN_SPAN_MS.text))
    .describe('Show a caption between start and end (at least 100 ms, inside the recording)'),
  z
    .object({
      op: z.literal('updateText'),
      id: existingId('text'),
      start: sourceStart.optional(),
      end: sourceEnd.optional(),
      text: textContent.optional(),
      ...textStyleFields
    })
    .strict()
    .refine(changesSomething, NOTHING_TO_CHANGE)
    .refine(spanLength(AGENT_MIN_SPAN_MS.text), spanMessage('text', AGENT_MIN_SPAN_MS.text))
    .describe('Change fields of an existing text; omitted fields stay as they are, at least one must be given'),
  z.object({ op: z.literal('removeText'), id: existingId('text') }).strict().describe('Delete a text'),
  z
    .object({
      op: z.literal('addBlur'),
      start: sourceStart,
      end: sourceEnd,
      x: normalized('Left edge of the rectangle, 0..1 of the SOURCE frame'),
      y: normalized('Top edge of the rectangle, 0..1 of the SOURCE frame'),
      w: normalized('Width of the rectangle, 0.01..1 of the SOURCE frame; x + w must not exceed 1'),
      h: normalized('Height of the rectangle, 0.01..1 of the SOURCE frame; y + h must not exceed 1'),
      style: z.enum(['blur', 'pixelate']).describe('"blur" (default) or "pixelate"').optional(),
      strength: z.number().min(4).max(80).describe('Blur radius / pixel block size in px at 1080p, 4 to 80 (default 24)').optional()
    })
    .strict()
    .refine(spanLength(AGENT_MIN_SPAN_MS.blur), spanMessage('blur', AGENT_MIN_SPAN_MS.blur))
    .refine(rectFits(MIN_BLUR_SIZE), rectMessage(MIN_BLUR_SIZE))
    .describe('Hide a rectangle (passwords, e-mails, ...) between start and end (at least 100 ms, inside the recording). It sticks to the picture and follows zooms. Locate the area on a take_screenshot or on the recording first'),
  z.object({ op: z.literal('removeBlur'), id: existingId('blur') }).strict().describe('Delete a blur'),
  z
    .object({
      op: z.literal('setCrop'),
      x: normalized('Left edge, 0..1 of the source frame'),
      y: normalized('Top edge, 0..1 of the source frame'),
      w: normalized('Width, 0.05..1 of the source frame; x + w must not exceed 1'),
      h: normalized('Height, 0.05..1 of the source frame; y + h must not exceed 1')
    })
    .strict()
    .refine(rectFits(MIN_CROP_SIZE), rectMessage(MIN_CROP_SIZE))
    .describe('Crop the whole video to a rectangle. { x: 0, y: 0, w: 1, h: 1 } removes the crop'),
  z
    .object({
      op: z.literal('setFrame'),
      padding: z.number().min(0).max(0.2).describe('Space around the video as a fraction of its height, 0 to 0.2 (0 = none)').optional(),
      cornerRadius: z.number().min(0).max(64).describe('Corner radius of the video in px at 1080p, 0 to 64').optional(),
      background: frameBackground
        .describe(`Colour behind the video: ${OPAQUE_COLOR_HELP}; or "gradient:dusk|ocean|sunset|mint|berry|slate"; or "transparent" (GIF export only)`)
        .optional(),
      shadow: z.boolean().describe('Drop shadow under the video').optional()
    })
    .strict()
    .refine(changesSomething, NOTHING_TO_CHANGE)
    .describe('Style the frame around the video; omitted fields stay as they are, at least one must be given'),
  z
    .object({
      op: z.literal('setCursor'),
      highlight: z.boolean().describe('Persistent highlight circle around the cursor').optional(),
      clicks: z.boolean().describe('Ripple animation on every recorded click').optional(),
      followSmoothing: z.number().min(0).max(1).describe('How lazily follow-zooms trail the cursor, 0..1 (default 0.6)').optional(),
      followDeadZone: z.number().min(0).max(0.3).describe('Distance the cursor may move from the centre before a follow-zoom pans, 0..0.3 (default 0.08)').optional()
    })
    .strict()
    .refine(changesSomething, NOTHING_TO_CHANGE)
    .describe('Cursor highlight, click ripples and follow-zoom behaviour; omitted fields stay as they are, at least one must be given')
])

/**
 * durationMs and pauseMs of an action. A duration is raised to the kind's minimum and never lowered:
 * above the maximum is an error (buildAgentScenario checks it exactly). The maximum is a minute, but a
 * scroll of over 900 notches or a text of over 2400 characters cannot be replayed in one, so their schemas
 * allow the longest scenario instead (get_scenario reports such a duration, and it has to be accepted again).
 */
const timing = (maxDurationMs: number) => ({
  durationMs: z
    .number()
    .min(0)
    .max(maxDurationMs)
    .describe(
      `How long the action takes, ms, at most ${DURATION_MAX_MS}` +
        (maxDurationMs > DURATION_MAX_MS ? ' (or the action\'s own minimum when that is longer: a scroll of hundreds of notches, a text of thousands of characters)' : '') +
        '; more is an error. A mouse action first glides there, then happens near the end of this time. Raised to the kind minimum ' +
        '(click 200, double click 300, drag 500, position-only click 150, key 150, type 25 per character, scroll 40 per notch and at least 300). ' +
        `Defaults: click and scroll 1000, drag 1500, key 500, type 80 per character (at most ${DURATION_MAX_MS} in all)`
    )
    .optional(),
  pauseMs: z.number().min(0).max(PAUSE_MAX_MS).describe('Stillness after the action, ms, at most 60000 (default 1500). Replay is strictly sequential: each action starts when the previous one and its pause are over').optional()
})
const modifiers = (what: string) => z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).describe(what).optional()
/** get_scenario reports an id for every action: accepting it back, unused, lets its actions go straight into create_scenario */
const ignoredId = {
  id: z
    .string()
    .describe('Ignored. get_scenario reports an id for each action; it may stay when you pass the actions back. Nothing reads it: the ids are assigned in order (a1, a2, ...)')
    .optional()
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
      modifiers: modifiers('Keys held during the click, e.g. ["ctrl"]. Not together with hoverOnly'),
      hoverOnly: z
        .boolean()
        .describe('true = only move the pointer to (x, y) and press nothing, not even `modifiers` (for hover effects and tooltips); the kind is then irrelevant. Default false')
        .optional(),
      ...timing(DURATION_MAX_MS),
      ...ignoredId
    })
    .strict()
    .describe('Move the mouse to (x, y) and click; with hoverOnly only move it there'),
  z
    .object({
      kind: z.literal('drag'),
      ...point,
      toX: z.number().describe('Where the button is released, DIP relative to the display'),
      toY: z.number().describe('Where the button is released, DIP relative to the display'),
      modifiers: modifiers('Keys held during the drag, e.g. ["shift"]'),
      ...timing(DURATION_MAX_MS),
      ...ignoredId
    })
    .strict()
    .describe('Press the left button at (x, y), move to (toX, toY), release'),
  z
    .object({
      kind: z.literal('scroll'),
      ...point,
      deltaY: z
        .number()
        .int()
        .min(-AGENT_SCROLL_MAX_NOTCHES)
        .max(AGENT_SCROLL_MAX_NOTCHES)
        .describe(`Wheel notches, positive = content scrolls down, at most ${AGENT_SCROLL_MAX_NOTCHES} either way (default 3 when deltaX is not given either; both 0 only moves the cursor)`)
        .optional(),
      deltaX: z
        .number()
        .int()
        .min(-AGENT_SCROLL_MAX_NOTCHES)
        .max(AGENT_SCROLL_MAX_NOTCHES)
        .describe(`Horizontal wheel notches, positive = right, at most ${AGENT_SCROLL_MAX_NOTCHES} either way`)
        .optional(),
      ...timing(SCENARIO_MAX_MS),
      ...ignoredId
    })
    .strict()
    .describe('Move the mouse to (x, y) and turn the wheel'),
  z
    .object({
      kind: z.literal('type'),
      text: z
        .string()
        .min(1)
        // characters as a person sees them, like the builder counts (a code-unit .max() would cut emoji short)
        .refine((s) => graphemes(s).length <= AGENT_TYPE_MAX_CHARS, `must be at most ${AGENT_TYPE_MAX_CHARS} characters`)
        .describe(
          `Text to type into whatever has focus (any language; typed as Unicode), at most ${AGENT_TYPE_MAX_CHARS} characters. ` +
            'No newlines or tabs: use key actions "Enter" / "Tab"'
        ),
      ...timing(SCENARIO_MAX_MS),
      ...ignoredId
    })
    .strict()
    // like a scroll, a text can be too long to type in a minute (over 2400 characters): then its own minimum is the limit
    .refine((a) => a.durationMs === undefined || a.durationMs <= Math.max(DURATION_MAX_MS, graphemes(a.text).length * TYPE_MIN_MS_PER_CHAR), {
      message: `durationMs may be at most ${DURATION_MAX_MS} ms (more only for a text so long that typing it takes longer)`,
      path: ['durationMs']
    })
    .describe('Type text, one character at a time, into the focused field'),
  z
    .object({
      kind: z.literal('key'),
      key: z.string().min(1).describe(`A key or shortcut, e.g. "Enter", "Escape", "Ctrl+S", "Ctrl+Shift+T", "Alt+Tab", "F5". ${KEY_CHORD_HELP}`),
      ...timing(DURATION_MAX_MS),
      ...ignoredId
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

const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/
/** frame rates the export dialog offers: mp4 24 / 30 / 60, gif 10 / 12 / 15 / 20 / 25 */
const EXPORT_FPS: Record<'mp4' | 'gif', readonly number[]> = { mp4: MP4_FPS_OPTIONS, gif: GIF_FPS_OPTIONS }
const ALL_EXPORT_FPS = [...new Set([...MP4_FPS_OPTIONS, ...GIF_FPS_OPTIONS])].sort((a, b) => a - b)

export const agentExportSchema = z
  .object({
    projectId,
    format: z.enum(['mp4', 'gif']).describe('Default: the format saved in the project (mp4 unless changed)').optional(),
    folder: z
      .string()
      .min(1)
      .regex(ABSOLUTE_PATH, 'must be an absolute path such as "C:\\Users\\me\\Videos"')
      .describe("Absolute folder for the file, created if missing. Default: the project's export folder (the Videos folder unless changed)")
      .optional(),
    fileName: z
      .string()
      .min(1)
      .max(200)
      .describe('File name without extension (a trailing .mp4 / .gif is removed). An existing file is never overwritten: "-2", "-3" is appended. Default: the project\'s export file name')
      .optional(),
    fps: z
      .number()
      .refine((n) => ALL_EXPORT_FPS.includes(n), `must be one of ${ALL_EXPORT_FPS.join(', ')}`)
      .describe(
        `Frames per second: ${MP4_FPS_OPTIONS.join(' / ')} for mp4, ${GIF_FPS_OPTIONS.join(' / ')} for gif. ` +
          "Default: the project's saved rate if the format offers it, else 30 (mp4) or 15 (gif)"
      )
      .optional(),
    scale: z.number().min(0.1).max(1).describe('Output size relative to the (cropped) recording, 0.1 to 1 (1 = its own size; the editor offers 1, 0.75, 0.5)').optional(),
    mp4Quality: z.enum(['low', 'medium', 'high', 'max']).describe('MP4 only').optional(),
    gifColors: z.union([z.literal(256), z.literal(128), z.literal(64), z.literal(32)]).describe('GIF palette size, 256 / 128 / 64 / 32').optional()
  })
  .strict()
  .refine((p) => p.fps === undefined || p.format === undefined || EXPORT_FPS[p.format].includes(p.fps), {
    message: `fps is not available for that format: mp4 offers ${MP4_FPS_OPTIONS.join(', ')}, gif offers ${GIF_FPS_OPTIONS.join(', ')}`,
    path: ['fps']
  })

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
    .object({ projectId, operations: z.array(agentEditOpSchema).min(1).max(MAX_EDIT_OPERATIONS).describe('Edits, applied in order as one undo step. Nothing is applied if any of them is rejected') })
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
