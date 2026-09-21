# ZoomCut – project notes for Claude Code

Free screen recorder and demo editor: Electron 44 + electron-vite 5 + Vite 7 + React 19 + TypeScript 5.9 + zustand.
Windows is the primary platform. Public repo `YungKellz/zoomcut`, branch `master`. Releases are GitHub releases with
an NSIS installer and a portable exe; installed copies auto-update from them.

## Commands

| command | notes |
| --- | --- |
| `npm run dev` | dev app with hot reload; restart it after changes in `src/main` or `src/preload` |
| `npm run typecheck` | main/preload/shared (`tsconfig.node.json`) and renderer (`tsconfig.json`) |
| `npm test` | vitest unit tests (`src/**/*.test.ts`): timeline/camera engine, audio export plan + ffmpeg graph, music scores, scenario engine, formatting helpers |
| `npm run build && npm run e2e` | Playwright tests on the real screen (`tests/e2e`): smoke, 46 adversarial scenarios, update feed, audio, scenario recorder (injects real input over the app's own test window); needs a display, ~7 min |
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
  (voiceover / music / file import into the project folder, orphan sweep), `scenario/` (input capture through the
  shared uiohook in `hook.ts`, key-text resolver and SendInput replay helpers as PowerShell scripts in
  `inputHelper.ts`, `capture.ts`, `replay.ts`, scenario storage under `userData/scenarios/<id>/`),
  `exportManager.ts`, `storage.ts` (projects in `%USERPROFILE%\Videos\ZoomCut\<timestamp>\`, `settings.json` in
  userData), `mediaProtocol.ts` (`zc-media://` with Range + CORS), `updater.ts` (electron-updater against GitHub
  Releases), `ipc.ts` (all channels; `e2e:*` handlers exist only under `ZOOMCUT_E2E=1`).
- `src/preload/index.ts` – exposes `window.zc`, typed by `src/shared/api.ts`.
- `src/shared` – data model (`types.ts`), defaults, the API contract, `audio.ts` helpers and the pure scenario
  engine `scenario.ts` (event grouping, retiming, path synthesis, replay compilation). Renderer and main only share these.
- `src/renderer/src` – React app: `screens/` (Home, Editor, RecorderBar, ScenarioReview, ReplayOverlay, E2eTarget),
  `editor/` (Preview, Timeline, Inspector, ExportDialog, AudioPlayer), `engine/` (timeline math, cursor, camera,
  `compose.ts` = the single frame compositor used by both preview and export), `export/` (Mediabunny/WebCodecs or
  raw RGBA → ffv1 path, size estimate, `audioPlan.ts`), `audio/music.ts` (procedural music presets), `scenario/`
  (review-screen helpers), `recording/` (`useRecorder.ts`, `useScenarioCapture.ts`), `store.ts` (zustand, lazy undo
  checkpoints), `i18n/`, `components/`, `hooks/`.
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
- Scenarios: coordinates are DIP screen coordinates of the virtual desktop (`screen.dipToScreenPoint` converts for
  SendInput), times are ms from the capture start; the first action is normalized to 1 s. `src/shared/scenario.ts`
  is the only place that groups raw hook events, retimes/deletes actions and compiles replay steps. Key text is
  resolved for the foreground window's keyboard layout, so typed text is replayed as Unicode regardless of layout.
  The replay helper must always release every key and button (abort file → exit, `-Release` after a hard kill).
- Env vars: `ZOOMCUT_E2E=1` (no single-instance lock, updater never installs on quit), `ZOOMCUT_RECORDINGS_DIR`,
  `ZOOMCUT_SCENARIOS_DIR`, `ZOOMCUT_EXE`, `ZOOMCUT_UPDATE_URL` (generic update feed: a folder with `latest.yml` +
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
- System-audio capture (`audio: 'loopback'`) fails with `NotReadableError` on this machine even in a bare Electron
  script (Chromium's WASAPI loopback vs. the headset); the app must keep degrading to "recorded without system
  audio" + notice. Text typed through `KEYEVENTF_UNICODE` is invisible to the hook (keycode 0), so tests that need a
  captured `type` action must type through scancode `key` steps; the characters then depend on the active layout.
- Both features append to shared files under section comments (`// ---- audio ----`, `// ---- scenario ----` in
  types/api/preload/ipc/i18n/styles); keep new keys inside the right section so the two dictionaries stay in sync.

## Releasing

1. Add `## X.Y.Z (YYYY-MM-DD)` to `CHANGELOG.md` (EN block, then `**RU**` block).
2. `npm version X.Y.Z --no-git-tag-version`, commit, `git tag vX.Y.Z`, push the branch and the tag.
3. `release.yml` builds on `windows-latest`, runs typecheck + unit tests, then publishes the release (created as a
   draft, assets uploaded, then published) with both exes, `latest.yml` and the `.blockmap`. Installed apps see it
   through `src/main/updater.ts`; the portable exe does not update itself.
4. The exe is not code-signed: SmartScreen shows "More info → Run anyway" on the first manual install (the release
   notes footer from `scripts/release-notes.cjs` says so in RU and EN). Updates downloaded by the app skip that prompt.
