# Changelog

Notable changes per version, English first, Russian below. The section of a version becomes the body of its
GitHub release (`node scripts/release-notes.cjs <version>`, run by `.github/workflows/release.yml`).

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
