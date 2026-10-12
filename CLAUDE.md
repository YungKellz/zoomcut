# ZoomCut – project notes for Claude Code

Free screen recorder and demo editor: Electron 44 + electron-vite 5 + Vite 7 + React 19 + TypeScript 5.9 + zustand.
Windows is the primary platform. Public repo `YungKellz/zoomcut`, branch `master`. Releases are GitHub releases with
an NSIS installer and a portable exe; installed copies auto-update from them.

## Commands

| command | notes |
| --- | --- |
| `npm run dev` | dev app with hot reload; restart it after changes in `src/main` or `src/preload` |
| `npm run typecheck` | main/preload/shared (`tsconfig.node.json`) and renderer (`tsconfig.json`) |
| `npm test` | vitest unit tests (`src/**/*.test.ts`): timeline/camera engine (incl. frame stepping), pick-area math, store zoom/playback actions, audio export plan + ffmpeg graph, waveform peaks, clip labels, scenario engine + dry run, input tags, window visibility, composition layout, GIF converter args + video file intake, formatting helpers, agent control (key chords, scenario builder, RPC schemas, control server, methods, MCP client and tools) |
| `npm run build && npm run e2e` | Playwright tests on the real screen (`tests/e2e`): smoke, 46 adversarial scenarios, update feed, audio, scenario recorder (injects real input over the app's own test window), blur + composition + MP4→GIF converter (`composition.spec.ts`, synthetic ffmpeg recordings, records nothing), zoom steps (`zoom-parts.spec.ts`, synthetic), delete / record again / home layout (`lifecycle.spec.ts`), playback end + frame step (`playback.spec.ts`, synthetic), timeline lanes + input tags (`timeline-lanes.spec.ts`, synthetic), Clip tab windows (`windows.spec.ts`, synthetic), agent control through the real stdio bridge + a real MCP client (`agent.spec.ts`; its scenario replay test only with `ZOOMCUT_E2E_REPLAY=1`); needs a display, ~20 min |
| `npm run build` | electron-vite bundles, then the MCP bridge (`mcp.vite.config.ts` → `out/mcp/zoomcut-mcp.cjs`, one CJS file); `src/mcp/bridge.test.ts` runs that file over stdio and skips itself until it exists |
| `npm run dist` | installer + portable exe + `latest.yml` + `.blockmap` in `release/`; never publishes |

- `ZOOMCUT_EXE=release/win-unpacked/ZoomCut.exe npm run e2e` runs the e2e tests against the packaged app.
- After e2e runs delete `tests/e2e/.tmp`: it holds screen captures of this machine. The tests switch the UI to
  English and can write defaults into `%APPDATA%\zoomcut\settings.json`; `restoreUserSettings()` in
  `tests/e2e/adv-helpers.ts` resets `language`, `cursorDefaults` and `frameDefaults`.
- Do the real verification before claiming something works: typecheck, unit tests, and the e2e specs that touch
  the changed area.

## Layout

- `src/main` – Electron main process. `windows.ts` (main window, floating recorder bar and the replay overlay,
  both content-protected; e2e target window), `recorder/` (controller, 60 Hz cursor tracker with uiohook clicks,
  window layout snapshot via PowerShell), `media/ffmpeg.ts` (transcode, x264 MP4, two-pass GIF palettes, audio
  conversion), `media/audioGraph.ts` (pure ffmpeg filter graph for the audio mix), `media/audioImport.ts`
  (voiceover / music / file import into the project folder, orphan sweep), `media/projectPaths.ts` (leaf module
  with the project folder helpers), `audio/loopback.ts` (system audio: WASAPI loopback helper in PowerShell/C#,
  see Gotchas), `audio/musicLibrary.ts` (the bundled CC0 tracks in `resources/music`, copied into the installer
  as `extraResources`), `psHelper.ts` (writes/spawns the PowerShell helpers), `scenario/` (input capture through the
  shared uiohook in `hook.ts`, key-text resolver and SendInput replay helpers as PowerShell scripts in
  `inputHelper.ts`, `capture.ts`, `replay.ts`, `preview.ts` = the "Preview" dry run (a `ReplaySession` without
  `RecordingController`, mutually exclusive with recording and capture through the busy checks wired in `index.ts`;
  `scenario:preview` / `scenario:preview-abort` / `scenario:preview-state`), scenario storage under
  `userData/scenarios/<id>/`),
  `composition/storage.ts` (compositions as `<id>.json` in `userData/compositions`), `media/gifConvert.ts` (the
  standalone MP4 → GIF converter: file picker or a dropped path (`probe`, validated by `media/videoFile.ts`) +
  `encodeGif` with an fps/scale prefilter and a trim; `windows.ts` also blocks the main window from navigating to a
  dropped file),
  `exportManager.ts`, `storage.ts` (projects in `%USERPROFILE%\Videos\ZoomCut\<timestamp>\`, `settings.json` in
  userData), `mediaProtocol.ts` (`zc-media://` with Range + CORS), `updater.ts` (electron-updater against GitHub
  Releases), `ipc.ts` (all channels; `e2e:*` handlers exist only under `ZOOMCUT_E2E=1`).
- `src/preload/index.ts` – exposes `window.zc`, typed by `src/shared/api.ts`.
- `src/main/agent` – agent control (MCP): `server.ts` (loopback `POST /rpc`, Electron-free), `methods.ts` (the RPC table, Electron and
  disk injected), `rendererBridge.ts` (`agent:command` / `agent:reply` with a pending map, the renderer's `agent:status`
  cache), `waiter.ts`, `mcpConfig.ts` (what the Home dialog shows), `index.ts` (Electron wiring, `agent:*` IPC, discovery file).
  `src/mcp` – the stdio MCP bridge: `tools.ts` (the 18 tools and their descriptions), `rpc.ts` (finds / starts the app,
  node:http client), `zoomcut-mcp.ts` (entry); built by `mcp.vite.config.ts`, shipped as `resources/mcp/zoomcut-mcp.cjs`
  (`extraResources`). The renderer side is `src/renderer/src/agent/` (executor, edits, params).
- `src/shared` – data model (`types.ts`), defaults, the API contract, `audio.ts` helpers and the pure scenario
  engine `scenario.ts` (event grouping, timing model and edits, v1 → v2 migration, replay compilation), `videoFiles.ts`
  (video extensions + the coded `video-file:<code>` errors main throws), the agent contract (`agent.ts` types + `AgentError`,
  `agentSchemas.ts` zod params, `agentKeys.ts`, `agentScenario.ts`, `agentProject.ts`). Renderer and main only share these.
- `src/renderer/src` – React app: `screens/` (Home, Editor, Composition, RecorderBar, ScenarioReview, ReplayOverlay, E2eTarget),
  `editor/` (Preview, Timeline, Inspector, ExportDialog, AudioPlayer), `engine/` (timeline math, cursor, camera,
  `compose.ts` = the single frame compositor used by both preview and export), `export/` (Mediabunny/WebCodecs or
  raw RGBA → ffv1 path, size estimate, `audioPlan.ts`), `audio/` (`clipLabel.tsx` = the one place that names and
  icons audio clips, `peaks.ts` = waveform peaks decoded through `zc-media://`), `editor/AudioWaveform.tsx`,
  `scenario/` (review-screen helpers, `fields.tsx` seconds inputs + presets), `home/items.ts` (the unified home list),
  `composition/` (`layout.ts` = pure composition timeline/frame/audio math,
  `CompositionPlayer.tsx`), `converter/` (`GifConverterDialog.tsx`, the Home card `GifConverterCard.tsx`, `useVideoIntake.ts` = picker + file drop
  on the whole Home window, `intake.ts` = its pure helpers), `recording/` (`useRecorder.ts`, `useScenarioCapture.ts`, `lifecycle.ts` = delete / record again), `store.ts`
  (zustand, lazy undo checkpoints), `i18n/`, `components/`, `hooks/`.
- `tests/e2e` – Playwright specs and `adv-helpers.ts`; `scripts/` – icon rendering and release notes;
  `.github/workflows` – `ci.yml` (typecheck, tests, build) and `release.yml` (tag `v*` → GitHub release).

## Model and conventions

- All times in a project are **source milliseconds**. Cuts are removed ranges (`CutRange[]`); `engine/timeline.ts`
  maps between source and output time (`keepSegments`, `srcToOut`, `outToSrc`). The timeline UI shows output time,
  removed pieces vanish and can be restored from the Clip tab.
- Zooms are segments with `follow` (precomputed follow path, dead zone + smoothing) or `fixed` (point/area) mode;
  `resolveZoomOverlaps` keeps neighbours apart. Text fades are clamped to half the overlay length.
- `composeFrame` draws every frame for preview *and* export – change it in one place, never fork it.
- Every UI string goes through `useT()/t()` with a key in **both** `i18n/en.ts` and `i18n/ru.ts` (`ru` is typed
  `Record<TKey, string>`, so a missing key fails the typecheck).
- Last used cursor/frame settings become defaults for new projects through `AppSettings` (`cursorDefaults`,
  `frameDefaults`, `audioDefaults`); nothing else is global.
- Audio: `Project.audio` holds `AudioClip`s, always `.m4a` inside the project folder. Recorded clips (`system`, `mic`)
  sit in **source time** (`start` ≤ 0 is normal: the audio recorder starts before the first video frame) and follow
  the video through cuts; overlay clips (`voiceover`, `music`, `file`) sit in **output time**. The renderer builds an
  `AudioExportPlan` (`export/audioPlan.ts`), main turns it into the ffmpeg graph (`media/audioGraph.ts`); deleting a
  clip never deletes its file (undo), orphans are swept when the editor closes.
- Blurs: `Project.blurs` are rectangles in **source-normalized** coordinates (the whole recording, not the crop)
  with a source-time span; `composeFrame` draws them right after the video frame, mapped through the camera, so they
  follow zooms. The `blur` editor mode shows the cropped source without zoom/frame (like zoom-pick) and reuses
  `CropEditor`; selecting anything that is not a blur leaves the mode.
- Compositions: a `Composition` only references projects by id (`items[].projectId`), so every recording plays with
  its current edits; `composition/layout.ts` places them back to back (by output duration after cuts) and fits each
  into the composition frame over `background`. Export goes through the same `encodeParts` path as a project
  (`runCompositionExport`), audio plans are concatenated with shifted `outAt`. Editing a recording from a
  composition keeps `state.composition` set, so the editor's Back returns to the composition screen.
- Scenarios (`version: 2`): coordinates are DIP screen coordinates of the virtual desktop (`screen.dipToScreenPoint`
  converts for SendInput). Replay timing is purely sequential: action 0 starts at 0, every action takes its
  `durationMs` (per-kind default and floor; pointer actions travel there first, then act; `type`/`key` never move the
  cursor) and is followed by its `pauseMs` (default 1.5 s, the last one too); `at` is only the recorded time, never
  used for timing. Always read them through `actionDurationMs` / `actionPauseMs` / `scenarioSchedule`. v1 files are
  migrated to the defaults by `migrateScenario` (load, list and save). `src/shared/scenario.ts` is the only place that
  groups raw hook events, edits durations/pauses/text, deletes actions and compiles replay steps (ending with an `end`
  step, so the helper waits out the final pause). Key text is resolved for the foreground window's keyboard layout,
  so typed text is replayed as Unicode regardless of layout. The replay helper releases exactly what it pressed
  (abort file → exit); `-Release` after a hard kill releases only what `GetAsyncKeyState` reports as down – never send
  an up event for something that is not down (a lone right-button-up opens a context menu). A click action with
  `hoverOnly: true` ("Position only, no click") only brings the cursor there: `compileScenario` travels and presses
  nothing (no modifiers either), 150 ms floor; only a real `true` on a click kind survives `migrateScenario`, and it is
  set through `setActionHoverOnly`. A preview waits for the overlay page (`overlay:ready`) before its schedule starts.
- Projects carry `origin` (display, audio, scenario id) – what "Record again" repeats (`recording/lifecycle.ts`,
  handed to the screen that owns the recorder through `store.pendingStart`) and how Home nests recordings under their
  scenario (`home/items.ts`). Deleting a scenario keeps its recordings; project and scenario deletes run on the same
  per-id queue as their autosaves.
- Zoom parts ("Steps" in the UI since 0.4.1): a `fixed` zoom can hold `parts` (further areas, each from its `start`
  boundary); the zoom's own target/scale is area 0. `cameraAt` glides between areas (`engine/camera.ts`: `zoomAreas`,
  `normalizeZoomParts`). Every step can be removed except a lone one; removing area 0 promotes `parts[0]`. Picking an
  area (`mode: 'pickTarget'`) is modal: `editor/PickOverlay.tsx` covers the inspector with Apply / Cancel, `select()`
  ignores other items meanwhile; `engine/pickRect.ts` holds the move / Shift centre magnet / Alt symmetric resize math.
  Times derived from the playhead are stored as whole ms (no `439.20300000000003`).
- Editor chrome: inactive inspector tabs are icon-only (`.tab[data-tab="<id>"]` in e2e, never `:has-text`);
  `store.stepFrame` steps one frame in OUTPUT time (`engine/timeline.ts` `stepFrames`, cut pieces skipped) for the
  step buttons and ←/→; playback stops at the last kept frame and Play there restarts from the first one
  (`playStartTime`) - an ended `<video>` is never `play()`ed (it would restart from 0 and loop).
- Confirmations: `components/ConfirmPopover.tsx` `confirmAt(anchor, message, opts)` opens above the clicked button
  (never `window.confirm()`); e2e confirms through `acceptConfirm()`. Side-panel blocks use `components/Section.tsx`.
- Timeline: the ruler and the Video lane always, the Zoom / Text / Blur / Audio lanes only when they have items.
  Input tags on the Video lane come from `cursorData.input` (`shared/inputMarks.ts`, built at `CursorTracker.stop()`
  from the shared hook's button / wheel / key events): typing bursts, drags, scrolls, double / right / middle clicks,
  key combos. Privacy rule: typed characters are never stored or logged - a `type` mark is only its span, `label`
  only names combos / special keys. Older projects derive click tags from `clicks`.
- Clip tab windows: snapshots (`main/recorder/windowsSnapshot.ts`) keep only windows that were really visible
  (z-order occlusion with every painting window as an occluder, invisible overlays ignored; geometry in
  `shared/windows.ts`) and add `content` (the page rect, without tabs and address bar) for browsers via
  `Chrome_RenderWidgetHostHWND` / UI Automation. Old snapshots are filtered in the editor (`visibleWindows`).
- Home screen: a header (brand), two equal columns that scroll on their own (left = new recording, compositions,
  the MP4 → GIF card; right = recordings and scenarios as tinted blocks; stacked below ~900 px) and a footer row
  (language, version + updates, recordings folder). The page itself never scrolls. A video file dropped anywhere on
  Home (`useVideoIntake`, path from `window.zc.converter.pathForFile`) is validated and probed by main
  (`converter:probe`) and opens `GifConverterDialog` prefilled; refused files come back as `video-file:<code>`
  errors that `videoErrorText` translates. Rows are one big click target (the open button's `::after` covers the
  card); every delete asks through `confirmAt` with the clicked button as the anchor.
- Agent control (MCP) is off unless a run asks: `--agent-control` (a second launch with it switches the running copy on) or
  `ZOOMCUT_AGENT_CONTROL=1` starts `main/agent/server.ts` on 127.0.0.1 with a random port and token, written to
  `<userData>/agent-control.json` (`{port, token, pid, version}`, removed at quit; a request with an Origin header, a Host other
  than `127.0.0.1:<port>` or the wrong token is a bare 403). `src/mcp` (stdio, one tool per RPC method) finds the app through that
  file, starts it with `--agent-control` when it runs under ZoomCut.exe or knows `ZOOMCUT_EXE`, and calls `/rpc`; the app never
  speaks MCP itself. Adding a capability = a schema in `shared/agentSchemas.ts` (`agentParamSchemas`, used for the tool's input
  schema AND for validation in main; descriptions are the agent's manual, limits are the editor's real ones and values outside
  are rejected, never clamped), a handler in `main/agent/methods.ts`, a tool in `src/mcp/tools.ts`. What only the renderer can do
  (`projects.edit`, `projects.export`, starting a recording / replay / capture from Home) is forwarded over `agent:command`;
  such a start's reply only means "handed to the screen": main waits for the real phase itself through the events on
  `RecordingController` (`state`, `finished`, `cancelled`, `failed`) and `ScenarioCapture` (`state`, `done`, `failed`) and
  refuses with `busy` while a recording, capture or preview runs. Commands wait for the executor's first `agent:status` push.
  The `agent:*` IPC is registered on every run (the Home dialog shows the config either way); data changed behind the UI's back
  (project delete, scenario create / delete, a rename) is announced with `agent:data-changed`. Agent scenarios are display-
  relative DIP (`shared/agentScenario.ts` puts them on the virtual desktop, `startPoint` = display centre) and keys are chords
  (`shared/agentKeys.ts` gives the vk / scan / extended a captured chord has; `Win` alone or `Alt+Shift` are valid); a scenario
  folder must be created before `saveScenario` (it never creates one). Error codes: `bad_params`, `not_found`, `busy`,
  `cancelled`, `failed`, `no_window`, `unknown_method`. The bridge runs under ZoomCut.exe with `ELECTRON_RUN_AS_NODE=1` (installed
  copies) or `node` (portable: a copy in `userData/mcp`, dev: `out/mcp`); it logs to stderr only, stdout is the protocol.
- Env vars: `ZOOMCUT_E2E=1` (no single-instance lock, updater never installs on quit), `ZOOMCUT_RECORDINGS_DIR`,
  `ZOOMCUT_SCENARIOS_DIR`, `ZOOMCUT_COMPOSITIONS_DIR`, `ZOOMCUT_USER_DATA` (moves userData: settings, `agent-control.json`; the bridge reads it too), `ZOOMCUT_AGENT_CONTROL=1`, `ZOOMCUT_EXE` (e2e: the packaged app; for the MCP bridge: the exe it may start), `ZOOMCUT_UPDATE_URL` (generic update feed: a folder with `latest.yml` +
  installer), `ZOOMCUT_UPDATE_CHECK=1` (keep the updater on under `ZOOMCUT_E2E`).

## Gotchas

- React 19 has no global `JSX` namespace: `import type { JSX } from 'react'`.
- Shell heredocs and `node -e` on this machine mangle backslashes; write files with the editor tools and keep
  regexes free of exotic escapes (`exportManager.ts` builds its file-name regex with `String.fromCharCode`).
  Check a suspicious file with `cat -A`.
- PowerShell must run scripts from a temp `.ps1` via `-File`; `-Command -` with the script on stdin runs nothing.
- The Vite dev server binds `127.0.0.1` on purpose (an IPv6-only bind left the Electron window blank).
- Autosave: `saveProject` is serialized per project and skips projects whose folder is gone, so a deleted
  project is never resurrected by a late save; keep it that way when touching persistence.
- Commit messages that contain double quotes: pass them through `git commit -F <file>`.
- The e2e tests record the real screen; keep `workers: 1` in `playwright.config.ts`. `scenario.spec.ts` injects
  real mouse/keyboard input (over a test window the app opens itself under `ZOOMCUT_E2E=1`) – never run it, or any
  other input-injecting check, while something else is being driven on the same screen, and open the e2e target
  window once per spec (recreating it at the same position confuses Windows' wheel routing).
- System-audio capture (`audio: 'loopback'`, Chromium's own) failed with `NotReadableError` on this machine even in
  a bare Electron script: the default playback device's shared mix format was 8 channels / 44100 Hz / 32-bit float
  (WAVE_FORMAT_EXTENSIBLE), which Chromium's loopback does not handle even though plain WASAPI loopback on the same
  endpoint works fine. System audio is now captured with our own PowerShell/C# WASAPI loopback helper
  (`src/main/audio/loopback.ts`, started by `RecordingController.prepare()`) instead – the Chromium path
  (`installDisplayMediaHandler`'s `audio: 'loopback'` branch, the renderer's system `MediaRecorder`) is gone. The
  app still degrades to "recorded without system audio" + notice when the helper fails (no default playback
  device, ...) – see `RecordingWarning`/`recording.finish()`'s `warnings`. Text typed through `KEYEVENTF_UNICODE` is
  invisible to the hook (keycode 0), so tests that need a captured `type` action must type through scancode `key`
  steps; the characters then depend on the active layout.
- Both features append to shared files under section comments (`// ---- audio ----`, `// ---- scenario ----`, `// ---- composition ----`, `// ---- gif converter ----` in
  types/api/preload/ipc/i18n/styles); keep new keys inside the right section so the two dictionaries stay in sync.

## Releasing

1. Add `## X.Y.Z (YYYY-MM-DD)` to `CHANGELOG.md` (EN block, then `**RU**` block).
2. `npm version X.Y.Z --no-git-tag-version`, commit, `git tag vX.Y.Z`, push the branch and the tag.
3. `release.yml` builds on `windows-latest`, runs typecheck + unit tests, then publishes the release (created as a
   draft, assets uploaded, then published) with both exes, `latest.yml` and the `.blockmap`. Installed apps see it
   through `src/main/updater.ts`; the portable exe does not update itself.
4. The exe is not code-signed: SmartScreen shows "More info → Run anyway" on the first manual install (the release
   notes footer from `scripts/release-notes.cjs` says so in RU and EN). Updates downloaded by the app skip that prompt.
