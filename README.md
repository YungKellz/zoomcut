# ZoomCut

Free, open-source screen recorder and demo editor for showing product features to your team.
Windows first (macOS/Linux should work but are untested). MIT licensed, no accounts, no watermarks, no paid tier.
UI in English and Russian.

**Flow:** record a display → the recording opens in the editor → cut pieces out, add timed text,
add smooth zooms that follow the mouse (or zoom into an area you draw), highlight the cursor and clicks →
export MP4 or GIF with full control over size, frame rate and (for GIF) palette, dithering and transparency →
pick the file name and folder.

## Features

- **Recording**: any display, 60 fps H.264/VP9 capture, the app hides itself and shows a small floating bar
  (excluded from the capture). Stop with the bar or `Ctrl+Alt+R`. Mouse position is sampled at 60 Hz and
  clicks are captured with a global mouse hook; the cursor track is anchored on the first recorded frame,
  so highlights and zooms line up with the real cursor.
- **Cut & trim**: remove any number of ranges (drag on the video track, `I`/`O`, or trim to the playhead).
  The timeline shows the *result*: removed pieces simply disappear; restore them from the list in the
  Clip tab or with `Ctrl+Z`. The video track is a filmstrip of the cropped source with marks where you
  clicked while recording.
- **Text overlays**: any number of texts with start/end, position (drag on the preview), size, colours,
  background, alignment, fade/pop animation. Overlapping texts get their own lanes.
- **Zoom**: segments from 1.2× to 5× with eased transitions. *Follow cursor* pans smoothly after the recorded
  mouse with a dead zone and smoothing; *Fixed* zooms into a point you click or an area you draw on the frame
  ("Pick on the frame"). "Auto from clicks" builds zooms around click clusters.
- **Cursor**: persistent highlight circle (colour, radius, opacity, outline) and click ripples (left/right colours),
  plus a sync offset slider for fine tuning.
- **Crop & style**: crop to a region, optional padding with a colour/gradient background, rounded corners,
  shadow, or a **transparent background** (exported to GIF).
- **Export**: MP4 (x264, four CRF quality levels) or GIF (10–25 fps, 32–256 colours, palette computed
  globally / on changing pixels / per frame, dithering none / Sierra / Floyd–Steinberg / Bayer, loop on/off),
  at 100/75/50 % size, with a rough size estimate before you start. The "Crisp UI" preset keeps thin grey UI
  elements sharp. Choose the file name and the folder; the last folder is remembered.
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
| `npm run e2e`       | real end-to-end test: records the screen, edits, exports GIF + MP4 (needs a display; run `npm run build` first; `ZOOMCUT_EXE=release/win-unpacked/ZoomCut.exe` tests the packaged app) |

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
| `Delete`               | delete the selected item / cut the range / restore a selected removed piece |
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
  or as raw RGBA frames into a lossless ffv1 file when the background is transparent; then ffmpeg produces the
  final MP4 (`libx264`) or GIF (two-pass `palettegen` / `paletteuse`).
- ffmpeg comes from [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) (GPL build; ZoomCut's own code is MIT).

## Project layout

```
src/main       Electron main process: windows, recording controller, cursor tracker, ffmpeg, export, storage
src/preload    contextBridge API (window.zc)
src/renderer   React app: Home (record), Editor (preview, timeline, inspector, export dialog), engine/, i18n/
src/shared     data model, defaults and the API contract
tests/e2e      Playwright end-to-end smoke test
scripts        render-icon.cjs renders build/logo.svg into the app icon
```

## Быстрый старт (RU)

1. `npm install`, затем `npm run dev`. Язык интерфейса берётся из системы; переключатель – на главном экране.
2. Выберите дисплей и нажмите **Начать запись**. Окно спрячется, внизу экрана появится панель с таймером;
   она не попадает в запись. Остановить: кнопка **Стоп** или `Ctrl+Alt+R`.
3. Запись откроется в редакторе: выделите диапазон на дорожке видео и нажмите **Вырезать выделение** (или `C`) –
   кусок исчезнет с таймлайна (вернуть его можно из списка во вкладке «Клип» или через Ctrl+Z).
   `Z` добавляет зум, `T` – текст (перетаскивается прямо на превью). Во вкладке **Зум** кнопка «Указать на кадре»
   позволяет кликнуть точку или нарисовать область, к которой приблизить кадр. Вкладка **Курсор** отвечает за
   подсветку курсора и кликов.
4. **Экспорт** → MP4 или GIF. Для серо-белых интерфейсов с тонкими линиями используйте пресет **Чёткий UI**;
   для градиентов – **Плавные градиенты**. Диалог показывает ориентировочный вес файла. Имя файла и папка
   задаются там же. Прозрачный фон (вкладка **Стиль**) экспортируется в GIF.
