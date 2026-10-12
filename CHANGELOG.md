# Changelog

Notable changes per version, English first, Russian below. The section of a version becomes the body of its
GitHub release (`node scripts/release-notes.cjs <version>`, run by `.github/workflows/release.yml`).

## 0.5.0 (2026-10-12)

- **Control from AI agents (MCP)**: Claude Code, Claude Desktop, Cursor and other MCP clients can drive ZoomCut –
  record a display, take a screenshot, read and edit a recording (cuts, zooms, texts, blurs), export an MP4 or GIF,
  write a scenario of clicks and keystrokes and record ZoomCut replaying it. **AI agents (MCP)** on the home screen
  shows the ready-made config for your installation with a Copy button. It is off until an agent connects, listens
  only on 127.0.0.1 with a random token, and everything stays on your machine. Updating the app ends running MCP
  sessions.
- **Home screen, rearranged**: two columns that scroll on their own – new recording, compositions and the MP4 → GIF
  converter on the left, recordings and scenarios on the right (recordings and scenarios are now tinted blocks
  with a hover effect) – and a footer with the language, the version and the recordings folder. The audio
  checkboxes are tidy toggles, "Record scenario" is as big as "Start recording".
- **MP4 → GIF by drag & drop**: the converter is its own block on the home screen; drop a video anywhere on the home
  screen to open it with that file.
- **Confirmations in place**: deleting (and "Record again") asks in a small popover right above the button instead
  of a Windows dialog. Checkboxes and scrollbars got a consistent look; the recorder pill lost its boxy shadow.
- **Scenario editor**: the timing inputs sit at the end of every row; **Preview** runs the scenario on screen
  exactly like a recording would (real cursor, clicks, typing) without recording anything – Esc stops it;
  **"Position only, no click"** turns a click into a point the cursor just moves to (for hover effects);
  "Record video from scenario", "Record scenario again" and Delete live together in the footer.
- **Video editor**: Delete and Record again sit next to Export; inspector tabs show only the active tab's name, so
  all of them fit; frame back / frame forward buttons around Play (they stop playback); playback stops at the end
  instead of looping, and Play there starts over.
- **Zoom steps** (formerly parts): every step can be deleted (except a lone one), "Pick area" lives in the steps
  list, the area has a centre cross, **Shift** snaps it to the frame's centre lines, **Alt** resizes it around its
  centre, and Apply / Cancel cover the side panel until the area is set. Inspector sections are clearly framed
  blocks; no more fractional milliseconds like 439.20300000000003 ms.
- **Clip tab windows**: only windows that were really visible on the recorded screen are offered, and browsers get
  "Page only" – a crop to the page without the tab strip and the address bar.
- **Timeline**: only lanes with something on them are drawn (a fresh recording shows just the video), lane names
  are capitalized, and tags show where you typed, dragged, scrolled, double- or right-clicked or pressed a shortcut
  (with their length) – handy for finding where to cut. Typed text itself is never stored.

**RU**

- **Управление из ИИ-агентов (MCP)**: Claude Code, Claude Desktop, Cursor и другие MCP-клиенты могут управлять
  ZoomCut – записать экран, сделать скриншот, прочитать и отредактировать запись (вырезки, зумы, тексты, размытие),
  экспортировать MP4 или GIF, написать сценарий из кликов и нажатий клавиш и записать, как ZoomCut его проигрывает.
  Кнопка **ИИ-агенты (MCP)** на главной показывает готовую конфигурацию для вашей установки с кнопкой «Копировать».
  Управление выключено, пока агент не подключится, слушает только 127.0.0.1 со случайным токеном, и всё остаётся на
  вашем компьютере. Обновление приложения завершает запущенные MCP-сессии.
- **Главная, новая раскладка**: две колонки со своим скроллом – слева новая запись, композиции и конвертер MP4 → GIF,
  справа записи и сценарии (теперь это цветные блоки с ховер-эффектом), – и футер с языком, версией и папкой
  записей. Чекбоксы звука стали аккуратными переключателями, «Записать сценарий» – того же размера, что и «Начать
  запись».
- **MP4 → GIF перетаскиванием**: конвертер – отдельный блок на главной; видео можно бросить в любое место главной,
  и конвертер откроется с этим файлом.
- **Подтверждения на месте**: удаление (и «Записать заново») спрашивает в маленьком окошке прямо над кнопкой, а не
  системным диалогом Windows. Чекбоксы и полосы прокрутки оформлены единообразно, у пилюли записи пропала
  прямоугольная тень.
- **Редактор сценария**: поля таймингов стоят в конце каждой строки; **Предпросмотр** прогоняет сценарий на экране
  ровно как при записи (настоящий курсор, клики, ввод), но ничего не записывает – Esc останавливает;
  **«Положение без клика»** превращает клик в точку, куда курсор просто приезжает (для ховер-эффектов);
  «Записать видео по сценарию», «Записать сценарий заново» и «Удалить» собраны в футере.
- **Редактор видео**: «Удалить» и «Записать заново» рядом с «Экспортом»; у вкладок инспектора подписана только
  активная, поэтому помещаются все; кнопки «кадр назад» / «кадр вперёд» по бокам от Play (останавливают
  воспроизведение); воспроизведение останавливается в конце, а не крутится по кругу, Play в конце начинает сначала.
- **Шаги зума** (бывшие части): удалить можно любой шаг (кроме единственного), «Указать область» – в списке шагов,
  у области есть крест по центру, **Shift** примагничивает её к центральным линиям кадра, **Alt** меняет размер от
  центра, а «Применить / Отмена» перекрывают боковую панель, пока область не зафиксирована. Разделы инспектора –
  явные блоки; больше никаких дробных миллисекунд вроде 439.20300000000003 мс.
- **Окна во вкладке «Клип»**: предлагаются только окна, которые действительно были видны на записанном экране, а для
  браузеров есть «Только страница» – кадрирование по странице без вкладок и адресной строки.
- **Таймлайн**: рисуются только полосы, на которых что-то есть (у свежей записи – только видео), подписи полос с
  заглавной буквы, а метки показывают, где вы печатали, перетаскивали, прокручивали, делали двойной или правый
  клик или жали сочетание клавиш (с длительностью) – удобно искать, где резать. Сам набранный текст не сохраняется.

## 0.4.0 (2026-10-08)

- **Scenario editor, new timing**: every action is followed by its own pause – a separate row in the action list
  (1.5 s by default, also after the last action; 1 s / 1.5 s / 2 s presets, "All pauses" sets them at once) – and
  every action has its own duration, i.e. how long the mouse takes to get there (1 s / 1.5 s / 2 s presets; typed
  text gets Fast / Normal / Slow typing speed). Typed text can be edited. Older scenarios open with these defaults.
- **Fix**: a replay no longer ends with a right-click – the context menu that used to pop up at the end of every
  recording made from a scenario is gone (the replay helper now releases only the buttons and keys it pressed).
- **Delete and Record again** in the header of the video editor and of the scenario editor. "Record again" deletes
  the item and starts over with the same display, audio and scenario.
- **One list on the home screen**: recordings and scenarios together; the recordings made from a scenario are
  nested under it. Deleting a scenario keeps its recordings.
- **Zoom parts**: a fixed-area zoom can hold several areas – the camera glides from one to the next and returns to
  1× at the end; thin dividers on the zoom bar mark the parts and can be dragged.
- **Compositions** (several recordings back to back with their edits, one export), an **MP4 → GIF converter** on
  the home screen and **blur / pixelate regions** in the editor.

**RU**

- **Редактор сценария, новые тайминги**: после каждого действия идёт своя пауза – отдельный пункт списка (по
  умолчанию 1,5 с, в том числе после последнего действия; пресеты 1 с / 1,5 с / 2 с, «Все паузы» задаёт их разом),
  а у каждого действия своя длительность – за сколько мышка до него доезжает (пресеты 1 с / 1,5 с / 2 с, для
  текста – скорость набора «Быстро / Обычно / Медленно»). Набранный текст можно редактировать. Старые сценарии
  открываются с этими значениями по умолчанию.
- **Исправление**: воспроизведение больше не заканчивается правым кликом – контекстное меню в конце каждой записи
  по сценарию пропало (хелпер отпускает только те кнопки и клавиши, которые нажал сам).
- **Удалить и Записать заново** в шапке редактора ролика и редактора сценария. «Записать заново» удаляет запись
  и начинает съёмку на тех же условиях: тот же дисплей, звук и сценарий.
- **Один список на главной**: записи и сценарии вместе, записи по сценарию вложены под ним. Удаление сценария
  оставляет его записи.
- **Части зума**: в зуме по области можно задать несколько областей – камера плавно переезжает от одной к другой и
  в конце возвращается к 1×; части разделены на полосе зума тонкими линиями, их можно перетаскивать.
- **Композиции** (несколько записей подряд со всеми правками, один экспорт), **конвертер MP4 → GIF** на главной и
  **размытие / пикселизация областей** в редакторе.

## 0.3.0 (2026-09-21)

- **Audio in recordings**: the home screen has "Microphone" (with a device picker) and "System audio" checkboxes.
  Each source is recorded as its own track next to the video and shows up as a clip in the new **Audio** tab of
  the editor (volume, mute, sync offset, fades). Clips follow the video through cuts and are mixed into the MP4
  export as an AAC track; GIF stays silent. System audio is captured through the app's own WASAPI loopback, not
  Chromium's (which some playback devices' mix formats make unreliable) – it now works on those devices too. When
  there is no default playback device, or its driver refuses loopback outright, the screen is recorded without
  system audio and a notice says so.
- **Voiceover**: record narration from the microphone right in the editor while the preview plays; the clip lands
  at the playhead on the new audio track of the timeline and can be moved, faded, muted or deleted (undo works).
- **Music beds**: six bundled CC0 tracks (mood tag, duration, preview) – no licences, no attribution – plus
  "Add audio file…" for your own MP3/WAV/M4A/OGG/FLAC. Music loops to the end of the output and gets a fade-out
  by default.
- **Scenario recorder**: "Record scenario" captures what you do in your product – clicks, double clicks, drags,
  scrolls, typed text and shortcuts, with the mouse path, the timings and a screenshot of every clicked spot.
  The review screen lists the actions with thumbnails and a timeline: delete actions, change their times or the
  pause before them (Shift+drag / the gap field moves everything after it), up to 10 minutes. "Record & replay"
  then records the screen while the app replays the input for you, with click ripples, typed text and a progress
  HUD drawn over the screen (they are not in the recording). Esc aborts and discards, Stop / Ctrl+Alt+R keeps what
  was recorded, and the result opens in the editor like any recording. Scenarios are saved and can be replayed again.
- Tests: unit tests for the audio export plan / ffmpeg graph, the music scores and the scenario engine (grouping,
  retiming, replay compilation); e2e specs `audio.spec.ts` and `scenario.spec.ts` (the latter drives the real
  capture and replay with real input over a test window the app opens under `ZOOMCUT_E2E=1`).

**RU**

- **Звук в записи**: на главном экране появились флажки «Микрофон» (с выбором устройства) и «Системный звук».
  Каждый источник пишется отдельной дорожкой рядом с видео и виден клипом в новой вкладке **Аудио** редактора
  (громкость, mute, сдвиг синхронизации, фейды). Клипы следуют за видео через вырезанные куски и микшируются в
  MP4 как AAC-дорожка; GIF остаётся без звука. Системный звук захватывается через собственный WASAPI-loopback
  приложения, а не через Chromium (который ненадёжен на части устройств из-за их формата микширования) – теперь
  он работает и на таких устройствах. Если нет устройства воспроизведения по умолчанию или его драйвер вовсе
  отказывает в loopback, экран пишется без системного звука, а уведомление сообщает об этом.
- **Голос за кадром**: запись комментария с микрофона прямо в редакторе во время воспроизведения превью; клип
  ложится на новую аудио-дорожку таймлайна у курсора воспроизведения, его можно двигать, делать фейды, глушить и
  удалять (с отменой).
- **Музыкальные подложки**: шесть встроенных треков CC0 (тег настроения, длительность, прослушивание) – без
  лицензий и указания авторства – плюс «Добавить аудиофайл…» для своих MP3/WAV/M4A/OGG/FLAC. Музыка
  зацикливается до конца ролика и по умолчанию затухает в конце.
- **Рекордер сценариев**: «Записать сценарий» фиксирует ваши действия в продукте – клики, двойные клики,
  перетаскивания, прокрутку, набранный текст и хоткеи – с траекторией мыши, таймингами и скриншотом каждой точки
  клика. Экран просмотра показывает список действий с миниатюрами и таймлайн: действия можно удалять, менять их
  время или паузу перед ними (Shift+перетаскивание / поле паузы сдвигает всё, что после), в пределах 10 минут.
  «Записать и воспроизвести» запускает запись экрана, пока приложение само воспроизводит ввод, показывая круги
  кликов, набираемый текст и прогресс поверх экрана (в запись они не попадают). Esc прерывает и удаляет запись,
  Стоп / Ctrl+Alt+R сохраняет записанное, результат открывается в редакторе как обычная запись. Сценарии
  сохраняются, их можно воспроизвести ещё раз.
- Тесты: unit-тесты плана аудио-экспорта / ffmpeg-графа, музыкальных партитур и движка сценариев (группировка,
  тайминги, компиляция воспроизведения); e2e-спеки `audio.spec.ts` и `scenario.spec.ts` (второй гоняет настоящий
  захват и воспроизведение реальным вводом по тестовому окну, которое приложение открывает при `ZOOMCUT_E2E=1`).

## 0.2.0 (2026-09-21)

- **Auto-update** for the installed build: ZoomCut checks GitHub Releases shortly after start and every six
  hours, downloads a new version in the background and offers "Restart and update"; an update that was put off
  is installed silently when the app quits. The home screen shows the update status and has a manual
  "Check for updates". The portable exe is not updated automatically (it links to the releases page instead).
- Release workflow publishes `latest.yml` and the `.blockmap` next to the installers (the updater needs them)
  and no longer needs a token during the build.
- Docs: `CHANGELOG.md`, `CLAUDE.md` (project notes for Claude Code), README updated for the current labels
  ("Pick area", "Auto-zoom from clicks") and the update flow.

Version 0.1.0 has no updater: install 0.2.0 by hand once, later versions arrive by themselves.

**RU**

- **Автообновление** установленной версии: вскоре после запуска и раз в шесть часов ZoomCut проверяет
  GitHub Releases, в фоне скачивает новую версию и предлагает «Перезапустить и обновить»; отложенное обновление
  тихо ставится при выходе из приложения. На главном экране виден статус обновления и ссылка
  «Проверить обновления». Portable-версия сама не обновляется (вместо этого показана ссылка на страницу релизов).
- Workflow релиза выкладывает рядом с установщиками `latest.yml` и `.blockmap` (они нужны обновлятору)
  и больше не требует токен во время сборки.
- Документация: `CHANGELOG.md`, `CLAUDE.md`, README приведён к актуальным названиям кнопок и описывает обновления.

У версии 0.1.0 обновлятора нет: 0.2.0 нужно один раз поставить вручную, дальше версии будут приходить сами.

## 0.1.0 (2026-09-19)

First release: recording of a display with cursor and click tracking; editor with cuts, timed text overlays,
follow-cursor and fixed-area zooms, cursor highlight, crop (including crop to a window) and frame styles; MP4 and
GIF export with palette / dithering control, transparent GIF background and a size estimate; English and Russian UI.

**RU**

Первый релиз: запись дисплея с трекингом курсора и кликов; редактор с вырезанием кусков, текстом по таймингу,
зумом за курсором и по области, подсветкой курсора, кадрированием (в том числе по окну) и стилями рамки;
экспорт MP4 и GIF с управлением палитрой и дизерингом, прозрачным фоном GIF и оценкой размера файла;
интерфейс на английском и русском.
