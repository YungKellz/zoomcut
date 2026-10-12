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
  mouse with a dead zone and smoothing; *Fixed* zooms into an area you place on the frame ("Pick area": drag and resize the
  rectangle, then Apply); a fixed zoom can have several parts, and the camera glides from one area to the next.
  "Auto-zoom from clicks" builds zooms around click clusters.
- **Blur**: hide passwords, e-mails or other private details with blurred or pixelated rectangles (`B` or the Blur
  button), each with its own start/end on the timeline. While a rectangle is edited the preview shows the whole
  cropped frame without zoom; in the video the area sticks to the picture and follows zooms.
- **Cursor**: persistent highlight circle (colour, radius, opacity, outline) and click ripples (left/right colours),
  plus a sync offset slider for fine tuning.
- **Crop & style**: crop to a region, optional padding with a colour/gradient background, rounded corners,
  shadow, or a **transparent background** (exported to GIF).
- **Export**: MP4 (x264, four CRF quality levels) or GIF (10–25 fps, 32–256 colours, palette computed
  globally / on changing pixels / per frame, dithering none / Sierra / Floyd–Steinberg / Bayer, loop on/off),
  at 100/75/50 % size, with a rough size estimate before you start. The "Crisp UI" preset keeps thin grey UI
  elements sharp. Choose the file name and the folder; the last folder is remembered.
- **Compositions**: join several recordings into one video. A composition references the recordings, so each one
  plays with its current edits (cuts, zooms, texts, blurs, audio); reorder them, jump into the editor for one and
  back, pick the output frame (like the first recording, 1080p, 720p, square, vertical) and the background around
  recordings of a different shape, then export MP4 or GIF with the usual dialog.
- **MP4 → GIF**: a separate block on the home screen (drop a file anywhere on the window, or pick one) turns any video
  file (MP4, MOV, WebM, MKV, AVI) into a GIF with trim, width, frame rate and the same palette / dithering presets as the export.
- Projects autosave to `%USERPROFILE%\Videos\ZoomCut\<timestamp>\` (`source.mp4` + `project.json`) and can be reopened.
  The home screen lists recordings and scenarios together, with each scenario's recordings nested under it; both
  editors have Delete and "Record again" (same display, audio and scenario).
- **Updates**: the installed app checks GitHub Releases on start and every six hours, downloads a new version in the
  background and offers "Restart and update"; the portable exe is updated by hand.
- **Audio**: record the microphone and/or system audio along with the screen (each as its own track), record a
  voiceover in the editor while the preview plays, add one of six bundled CC0 music tracks (no licences, no
  attribution) or your own audio file. The Audio tab and the audio track on the timeline give volume, mute, fades,
  sync offset and position, with a peak-level waveform on the selected clip; the MP4 export mixes everything into
  an AAC track (GIF stays silent).
- **Scenario recorder**: "Record scenario" captures your clicks, drags, scrolls, typed text and shortcuts in your
  product with a screenshot of every clicked spot. Review the actions: every action has its own duration (how long
  the mouse takes to get there; 1 / 1.5 / 2 s presets, typing speed for text) and is followed by a pause (1.5 s by
  default, one control sets all pauses), typed text can be edited, actions deleted, a click can become "position
  only, no click" (the cursor just moves there, for hover effects), 10-minute limit. "Preview" runs it on screen
  without recording anything; "Record video from scenario" records the screen while it replays the input for you, with
  click ripples and a progress HUD drawn over the screen (not in the recording). Esc aborts, Stop keeps the recording,
  and the result opens in the editor. Scenarios are saved for another take after you fix your product.
- **AI agents (MCP)**: Claude Code, Claude Desktop, Cursor and other MCP clients can record, edit, export and write
  scenarios through ZoomCut (see [Control from AI agents (MCP)](#control-from-ai-agents-mcp)).

## Control from AI agents (MCP)

ZoomCut speaks the [Model Context Protocol](https://modelcontextprotocol.io) through a small bridge, so an AI agent can
do what you do by hand: record a display, look at the result, cut it, add zooms, texts and blurs, export an MP4 or GIF,
write a scenario of clicks and keystrokes and record ZoomCut replaying it. Everything stays on your machine.

**Set up.** Click **AI agents (MCP)** on the home screen: it shows the exact configuration for your installation, with
real paths and a Copy button, as the JSON for Claude Desktop / Cursor and as a `claude mcp add` command for Claude Code.
For an installed copy the config looks like this (the bridge runs under ZoomCut.exe itself, so no Node install is needed):

```json
{
  "mcpServers": {
    "zoomcut": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\ZoomCut\\ZoomCut.exe",
      "args": ["C:\\Users\\you\\AppData\\Local\\Programs\\ZoomCut\\resources\\mcp\\zoomcut-mcp.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

```
claude mcp add --transport stdio --env "ELECTRON_RUN_AS_NODE=1" zoomcut -- "C:\...\ZoomCut.exe" "C:\...\resources\mcp\zoomcut-mcp.cjs"
```

- **Portable exe**: it unpacks itself to a new temp folder on every run, so each start copies the bridge to
  `%APPDATA%\zoomcut\mcp\zoomcut-mcp.cjs` and the config uses `node` (Node 20+) with that path, plus
  `ZOOMCUT_EXE=<your ZoomCut-Portable exe>` so the bridge can start the app.
- **From source**: `npm run build` produces `out/mcp/zoomcut-mcp.cjs` (one self-contained file); point the client at
  `node out/mcp/zoomcut-mcp.cjs`. For a dev app run `ZOOMCUT_AGENT_CONTROL=1 npm run dev`.

**Starting.** Agent control is off unless a run asks for it. The bridge starts ZoomCut for you (`ZoomCut.exe
--agent-control`; a copy that is already open is switched on instead of starting a second one), or start it yourself with
`ZoomCut.exe --agent-control` or `ZOOMCUT_AGENT_CONTROL=1`. Then the app listens on `127.0.0.1` on a random port; the port
and a random token are written to `%APPDATA%\zoomcut\agent-control.json` while it runs and removed when it quits. Requests
need the token, and a browser page or another host cannot talk to it (anything carrying an `Origin` header or the wrong
`Host` is refused). Set `ZOOMCUT_USER_DATA` to keep that folder, and the app's settings, somewhere else.

**What the agent can do** (18 tools, one per capability; every description tells the agent the units and the risks):

| tool | what it does |
| --- | --- |
| `get_status` | version, open screen, recording / capture state, the recording open in the editor |
| `list_displays`, `take_screenshot` | displays and a PNG of one (with its scale, to turn pixels into click coordinates) |
| `start_recording`, `stop_recording`, `cancel_recording` | record the real screen, optionally with microphone / system audio |
| `list_projects`, `get_project` | saved recordings; one in detail: cuts, zooms, texts, blurs, crop, frame, recorded clicks |
| `edit_project` | rename, cuts, zooms (follow or fixed), texts, blurs, crop, frame, cursor; one undo step in the open editor |
| `export_project` | render to MP4 or GIF with the project's (or given) export settings |
| `delete_project`, `delete_scenario` | remove a recording / a scenario (a recording that is open in the editor is refused) |
| `list_scenarios`, `get_scenario`, `create_scenario` | read and write scenarios: click, double / right / middle click, drag, scroll, type, key (`"Ctrl+S"`) |
| `record_scenario` | replay a scenario while recording the screen |
| `start_scenario_capture`, `stop_scenario_capture` | capture a scenario while a person demonstrates it |

Good to know: recording captures the **real screen**, and `record_scenario` moves the **real mouse and keyboard** (Esc
aborts) - leave the machine alone while it runs. Times in `edit_project` are milliseconds of the *original* recording,
positions inside a recording are fractions 0..1 of its frame, and scenario coordinates are DIP relative to a display's
top-left corner (a `take_screenshot` pixel divided by the screenshot's `scale`). The editor keeps working while an agent
edits: changes show live and `Ctrl+Z` takes back a whole `edit_project` call.

## Run from source

Requirements: Node.js 22+ and npm. No Visual Studio / Rust toolchain needed: ffmpeg and the mouse hook ship as prebuilt binaries.

```bash
npm install
npm run dev
```

Other scripts:

| script              | what it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run build`     | production bundles in `out/` (also the MCP bridge, `out/mcp/zoomcut-mcp.cjs`) |
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
  final MP4 (`libx264`) or GIF (two-pass `palettegen` / `paletteuse`). Audio clips are trimmed, delayed, looped and
  faded in one ffmpeg filter graph and mixed into the MP4 as AAC.
- Audio sources: the microphone is a separate opus `MediaRecorder` (via `getUserMedia`); system audio is captured
  by main itself through its own plain WASAPI loopback (`src/main/audio/loopback.ts`, a PowerShell/C# helper – not
  Chromium's loopback, which some playback devices' mix formats make unreliable), converted to `.m4a` next to the
  video. The six bundled music tracks (`resources/music`, CC0) are copied into the project unchanged when you pick
  one. System audio is not available on every machine (no default playback device, driver refuses loopback); the
  app then records without it and says so.
- The scenario recorder captures input with the same global hook (mouse, wheel and keyboard), resolves typed
  characters for the active keyboard layout through a small PowerShell helper (`ToUnicodeEx`), and replays through
  another PowerShell helper that drives `SendInput` on a stopwatch anchored to the recording start. Both helpers are
  embedded in `src/main/scenario/inputHelper.ts`; nothing native is compiled.
- Agent control is a small authenticated loopback RPC inside the app (`src/main/agent`, only when started with
  `--agent-control`) and a separate stdio MCP server (`src/mcp`, built into one file) in front of it: the app itself never
  speaks MCP. The parameter schemas (`src/shared/agentSchemas.ts`, zod) are written once and used for the tools' input
  schemas and for validation in the app; edits run in the editor's own code, so they are the same operations (and one
  undo step) as by hand.
- ffmpeg comes from [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static) (GPL build; ZoomCut's own code is MIT).

## Project layout

```
src/main       Electron main process: windows, recording controller, cursor tracker, ffmpeg, export, storage
src/preload    contextBridge API (window.zc)
src/renderer   React app: Home (record), Editor (preview, timeline, inspector, export dialog), engine/, i18n/
src/shared     data model, defaults, the API contract and the agent-control contract / schemas
src/main/agent loopback control server and the RPC methods behind the MCP tools
src/mcp        the stdio MCP bridge (built into out/mcp/zoomcut-mcp.cjs by mcp.vite.config.ts)
tests/e2e      Playwright end-to-end tests (smoke, adversarial scenarios, update feed)
scripts        render-icon.cjs renders build/logo.svg into the app icon; release-notes.cjs prints a CHANGELOG section
```

## Releases and auto-update

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`: it builds the installer and the portable exe and publishes
a GitHub release with them, `latest.yml` and the `.blockmap`. Installed copies (the Setup exe) check that feed on
start and every six hours through [electron-updater](https://www.electron.build/auto-update), download a new installer
in the background and offer "Restart and update"; an update that was put off is installed silently when the app quits.
The portable exe does not update itself. `ZOOMCUT_UPDATE_URL=http://host/folder/` points the updater at a local feed
for testing (see `tests/e2e/update.spec.ts`). Version history: [CHANGELOG.md](CHANGELOG.md).

## Быстрый старт (RU)

1. `npm install`, затем `npm run dev`. Язык интерфейса берётся из системы; переключатель – на главном экране.
2. Выберите дисплей и нажмите **Начать запись**. Окно спрячется, внизу экрана появится панель с таймером;
   она не попадает в запись. Остановить: кнопка **Стоп** или `Ctrl+Alt+R`.
3. Запись откроется в редакторе: выделите диапазон на дорожке видео и нажмите **Вырезать выделение** (или `C`) –
   кусок исчезнет с таймлайна (вернуть его можно из списка во вкладке «Клип» или через Ctrl+Z).
   `Z` добавляет зум, `T` – текст (перетаскивается прямо на превью). Во вкладке **Зум** кнопка «Указать область»
   позволяет выделить на кадре область, к которой приблизить картинку. Вкладка **Курсор** отвечает за
   подсветку курсора и кликов.
   Вкладка **Аудио**: клипы микрофона / системного звука (флажки на главном экране), запись голоса за кадром,
   музыкальные подложки и свои файлы; всё это микшируется в MP4.
   **Записать сценарий** на главном экране: покликайте по своему продукту, остановите панелью – откроется экран
   со списком действий и таймлайном (удаление, тайминги, «Положение без клика» для наведения, лимит 10 минут);
   «Предпросмотр» прогонит сценарий на экране без записи, «Записать видео по сценарию» запишет экран, пока
   приложение само повторит действия (Esc прерывает, Стоп сохраняет запись).
   `B` или кнопка **Размытие** добавляет прямоугольник размытия/пикселизации: пока он редактируется, превью
   показывает весь кадр кропа без зума; в видео область привязана к картинке и следует за зумом.
   **Композиции** на главном экране склеивают несколько записей (каждую с её текущей обработкой) в одно видео.
   Блок **MP4 → GIF** на главном экране конвертирует любой видеофайл в GIF: перетащите файл в окно или нажмите «Выбрать файл».
4. **Экспорт** → MP4 или GIF. Для серо-белых интерфейсов с тонкими линиями используйте пресет **Чёткий UI**;
   для градиентов – **Плавные градиенты**. Диалог показывает ориентировочный вес файла. Имя файла и папка
   задаются там же. Прозрачный фон (вкладка **Стиль**) экспортируется в GIF.
5. Установленная версия (Setup) сама проверяет обновления на GitHub при запуске, скачивает новую версию в фоне и
   предлагает перезапуститься; отложенное обновление ставится при выходе. Portable-версию нужно скачивать заново.

**ИИ-агенты (MCP).** Кнопка **ИИ-агенты (MCP)** на главном экране показывает готовую конфигурацию для Claude Code,
Claude Desktop и Cursor с настоящими путями. Агент может записывать экран, резать запись, добавлять зумы,
тексты и блюр, экспортировать MP4 / GIF и писать сценарии. Управление включается только по запросу
(`ZoomCut.exe --agent-control` или `ZOOMCUT_AGENT_CONTROL=1`; мост запускает приложение сам) и слушает только
`127.0.0.1` с случайным токеном. Подробности – в разделе «Control from AI agents (MCP)» выше.
