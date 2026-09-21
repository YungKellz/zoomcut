# Changelog

Notable changes per version, English first, Russian below. The section of a version becomes the body of its
GitHub release (`node scripts/release-notes.cjs <version>`, run by `.github/workflows/release.yml`).

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
