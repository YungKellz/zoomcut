# ZoomCut

Free, open-source screen recorder and demo editor for showing product features to your team.
Windows first (macOS/Linux should work but are untested). MIT licensed, no accounts, no watermarks, no paid tier.

**Flow:** record a display → the recording opens in the editor → trim, cut pieces out, add timed text,
add smooth zooms that follow the mouse, highlight the cursor and clicks → export MP4 or GIF with full
control over size, frame rate and (for GIF) palette and dithering → pick the file name and folder.

## Features

- **Recording**: any display, 60 fps H.264/VP9 capture, the app hides itself and shows a small floating bar
  (excluded from the capture). Stop with the bar or `Ctrl+Alt+R`. Mouse position is sampled at 60 Hz and
  clicks are captured with a global mouse hook, so highlights and zooms can be added *after* recording.
- **Trim & cut**: cut any number of ranges out of the recording (drag on the video track, `I`/`O`, or trim to the playhead).
  Cuts are skipped in playback and export.
- **Text overlays**: any number of texts with start/end time, position (drag on the preview), size, colours,
  background, alignment, fade/pop animation. Overlapping texts get their own lanes.
- **Zoom**: zoom segments (1.2×–4×) with eased in/out transitions. *Follow cursor* mode pans smoothly after the
  recorded mouse with a dead zone and adjustable smoothing; *fixed point* mode zooms on a point you pick on the frame.
  "Auto from clicks" builds zooms around click clusters in one click.
- **Cursor**: persistent highlight circle (colour, radius, opacity, outline) and click ripples (left/right colours).
  Sync offset slider in case the highlight runs ahead of the real cursor.
- **Crop & style**: crop to a region of the screen, optional padding with a colour/gradient background,
  rounded corners and shadow.
- **Export**: MP4 (x264, CRF quality levels) or GIF (10–25 fps, 32–256 colours, palette computed globally / on
  changing pixels / per frame, dithering none / Sierra / Floyd–Steinberg / Bayer, loop on/off), at 100/75/50 % size.
  The "Crisp UI" GIF preset (no dithering, 256 colours, diff palette) keeps thin grey UI elements sharp.
  Choose the file name and the folder; the last folder is remembered.
- Projects autosave to `%USERPROFILE%\Videos\ZoomCut\<timestamp>\` (`source.mp4` + `project.json`) and can be reopened.

## Run from source

Requirements: Node.js 22+ and npm. No Visual Studio / Rust toolchain needed: ffmpeg and the mouse hook ship as prebuilt binaries.

```bash
npm install
npm run dev
```

Other scripts:

| script              | what it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run build`     | production bundles in `out/`                                        |
| `npm start`         | run the production bundles                                          |
| `npm run dist`      | Windows installer + portable exe in `release/` (electron-builder)   |
| `npm run typecheck` | TypeScript checks for main, preload and renderer                    |
| `npm test`          | unit tests for the timeline / camera / cursor engine (vitest)       |
| `npm run e2e`       | real end-to-end test: records the screen, edits, exports GIF + MP4 (needs a display; run `npm run build` first) |

## Keyboard shortcuts (editor)

| key                    | action                                  |
| ---------------------- | --------------------------------------- |
| `Space`                | play / pause                            |
| `←` / `→`, `Shift+←/→` | one frame / one second                  |
| `Home` / `End`         | start / end                             |
| `I` / `O`              | set range start / end at the playhead   |
| `C`                    | cut the selected range                  |
| `Z`                    | add a zoom at the playhead              |
| `T`                    | add a text at the playhead              |
| `Delete`               | delete the selected item / cut the range|
| `Ctrl+Z` / `Ctrl+Y`    | undo / redo                             |
| `Esc`                  | leave crop / pick mode, clear selection |
| `Ctrl` + wheel         | zoom the timeline                       |

## How it works

- **Electron + React + TypeScript**, built with electron-vite.
- Capture uses `getDisplayMedia` with Electron's display-media handler and `MediaRecorder`; the raw file is
  transcoded once with ffmpeg into a constant-frame-rate, seekable H.264 MP4 for fast scrubbing.
- Cursor positions come from `screen.getCursorScreenPoint()` polled at 60 Hz; clicks from
  [uiohook-napi](https://github.com/SnosMe/uiohook-napi) (only `mousedown` is subscribed, no keyboard events).
- The editor composites every frame on a 2D canvas (`src/renderer/src/engine/compose.ts`) – the same function is used
  for the live preview and the export, so what you see is what you get.
- Export renders frames through [Mediabunny](https://mediabunny.dev) (WebCodecs H.264 encode, streamed to disk),
  then ffmpeg produces the final MP4 (`libx264`) or GIF (two-pass `palettegen` / `paletteuse`).
- ffmpeg comes from [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) (GPL build; ZoomCut's own code is MIT).

## Project layout

```
src/main       Electron main process: windows, recording controller, cursor tracker, ffmpeg, export, storage
src/preload    contextBridge API (window.zc)
src/renderer   React app: Home (record), Editor (preview, timeline, inspector, export dialog), engine/
src/shared     data model, defaults and the API contract
tests/e2e      Playwright end-to-end smoke test
```

## Быстрый старт (RU)

1. `npm install`, затем `npm run dev`.
2. Выберите дисплей и нажмите **Start recording**. Окно спрячется, внизу экрана появится панель с таймером;
   она не попадает в запись. Остановить: кнопка **Stop** или `Ctrl+Alt+R`.
3. Запись откроется в редакторе: выделите диапазон на дорожке видео и нажмите **Cut selection** (или `C`),
   `Z` добавляет зум в позиции курсора таймлайна, `T` добавляет текст (перетаскивается прямо на превью).
   Вкладка **Cursor** включает подсветку курсора и кликов, вкладка **Zoom** переключает режим слежения за мышкой.
4. **Export** → MP4 или GIF. Для серо-белых интерфейсов с тонкими линиями используйте пресет **Crisp UI**
   (без дизеринга, 256 цветов, палитра по изменяющимся пикселям); для градиентов – **Smooth gradients**.
   Имя файла и папка задаются в том же диалоге.
