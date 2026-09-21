# Bundled music beds

Six background tracks shipped with ZoomCut for the "Add music" picker in the editor. All of them were published on
FreePD.com under the **Creative Commons CC0 1.0 Universal (public domain) dedication**: free for any use, including
commercial, no attribution required. FreePD.com closed in 2026; the files were taken from the CC0 mirror
`https://github.com/SoundSafari/CC0-1.0-Music` (folder `freepd.com`) on 2026-09-21 and re-encoded to stereo AAC 128 kbps
(`.m4a`, 48 kHz) for size. The original artists are credited below as a courtesy, not as a licence requirement.

| file | title | artist | mood |
| --- | --- | --- | --- |
| `happy-whistling-ukulele.m4a` | Happy Whistling Ukulele | Rafael Krux | upbeat, light |
| `inspiration.m4a` | Inspiration | Rafael Krux | corporate, uplifting |
| `city-sunshine.m4a` | City Sunshine | Kevin MacLeod | bright, cheerful |
| `study-and-relax.m4a` | Study and Relax | Kevin MacLeod | lo-fi, calm |
| `lovely-piano-song.m4a` | Lovely Piano Song | Rafael Krux | calm piano |
| `ambient-bongos.m4a` | Ambient Bongos | Alexander Nakarada | minimal, percussive |

`manifest.json` next to this file is what the app reads (ids, titles, moods, durations). The folder is copied into the
installer as `resources/music` (electron-builder `extraResources`) and served to the editor through `zc-media://`.
