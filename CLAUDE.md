# ZoomCut – project notes for Claude Code

Free screen recorder and demo editor: Electron 44 + electron-vite 5 + Vite 7 + React 19 + TypeScript 5.9 + zustand.
Windows is the primary platform. Public repo `YungKellz/zoomcut`, branch `master`. Releases are GitHub releases with
an NSIS installer and a portable exe; installed copies auto-update from them.

## Commands

| command | notes |
| --- | --- |
| `npm run dev` | dev app with hot reload; restart it after changes in `src/main` or `src/preload` |
| `npm run typecheck` | main/preload/shared (`tsconfig.node.json`) and renderer (`tsconfig.json`) |
| `npm test` | vitest unit tests for the engine (`src/renderer/src/engine/*.test.ts`) |
| `npm run build && npm run e2e` | Playwright tests on the real screen (`tests/e2e`): smoke, 46 adversarial scenarios, update feed; needs a display, ~6 min |
| `npm run dist` | installer + portable exe + `latest.yml` + `.blockmap` in `release/`; never publishes |

- `ZOOMCUT_EXE=release/win-unpacked/ZoomCut.exe npm run e2e` runs the e2e tests against the packaged app.
- After e2e runs delete `tests/e2e/.tmp`: it holds screen captures of this machine. The tests switch the UI to
  English and can write defaults into `%APPDATA%\zoomcut\settings.json`; `restoreUserSettings()` in
  `tests/e2e/adv-helpers.ts` resets `language`, `cursorDefaults` and `frameDefaults`.
- Do the real verification before claiming something works: typecheck, unit tests, and the e2e specs that touch
  the changed area.

## Layout

- `src/main` – Electron main process. `windows.ts` (main window + floating recorder bar with content protection),
  `recorder/` (controller, 60 Hz cursor tracker with uiohook clicks, window layout snapshot via PowerShell),
  `media/ffmpeg.ts` (transcode, x264 MP4, two-pass GIF palettes), `exportManager.ts`, `storage.ts` (projects in
  `%USERPROFILE%\Videos\ZoomCut\<timestamp>\`, `settings.json` in userData), `mediaProtocol.ts` (`zc-media://`
  with Range + CORS), `updater.ts` (electron-updater against GitHub Releases), `ipc.ts` (all channels).
- `src/preload/index.ts` – exposes `window.zc`, typed by `src/shared/api.ts`.
- `src/shared` – data model (`types.ts`), defaults, the API contract. Renderer and main only share these.
- `src/renderer/src` – React app: `screens/` (Home, Editor, RecorderBar), `editor/` (Preview, Timeline, Inspector,
  ExportDialog), `engine/` (timeline math, cursor, camera, `compose.ts` = the single frame compositor used by
  both preview and export), `export/` (Mediabunny/WebCodecs or raw RGBA → ffv1 path, size estimate),
  `recording/useRecorder.ts`, `store.ts` (zustand, lazy undo checkpoints), `i18n/`, `components/`, `hooks/`.
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
  `frameDefaults`); nothing else is global.
- Env vars: `ZOOMCUT_E2E=1` (no single-instance lock, updater never installs on quit), `ZOOMCUT_RECORDINGS_DIR`,
  `ZOOMCUT_EXE`, `ZOOMCUT_UPDATE_URL` (generic update feed: a folder with `latest.yml` + installer),
  `ZOOMCUT_UPDATE_CHECK=1` (keep the updater on under `ZOOMCUT_E2E`).

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
- The e2e tests record the real screen; keep `workers: 1` in `playwright.config.ts`.

## Releasing

1. Add `## X.Y.Z (YYYY-MM-DD)` to `CHANGELOG.md` (EN block, then `**RU**` block).
2. `npm version X.Y.Z --no-git-tag-version`, commit, `git tag vX.Y.Z`, push the branch and the tag.
3. `release.yml` builds on `windows-latest`, runs typecheck + unit tests, then publishes the release (created as a
   draft, assets uploaded, then published) with both exes, `latest.yml` and the `.blockmap`. Installed apps see it
   through `src/main/updater.ts`; the portable exe does not update itself.
4. The exe is not code-signed: SmartScreen shows "More info → Run anyway" on the first manual install (the release
   notes footer from `scripts/release-notes.cjs` says so in RU and EN). Updates downloaded by the app skip that prompt.
