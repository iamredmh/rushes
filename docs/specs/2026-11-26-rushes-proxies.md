# §36 Proxies you can choose and switch on

## 36.1 The problem

Red, 26 Nov 2026, reviewing Cloud Engines Shorts from the DFINITY MacBook through the `mini rushes` tunnel. Tailscale goes through its London relay there, and a 30 MB ranged fetch ran at 0.64–0.75 MB/s (5–6 Mbps). The cuts are 1080p H.264 at 36–44 Mbps, 33–156 MB. They pass every §19.5 check (not 4K, under 1.5 GB, a codec browsers play), so Rushes never offers a proxy, and they stall constantly.

§19.5's machinery works. What's missing is the choice: when a proxy is made, at what quality, and one way to switch.

## 36.2 Decision (Red, 26 Nov 2026)

1. **Four quality presets**, simple names: 1080p High, 1080p Low, 720p High, 720p Low.
2. **A Proxies tab next to Activity**, where the quality is chosen and proxies are fine-tuned.
3. **An "always make proxies" switch per project**, so every new cut gets one at the chosen quality.
4. **One button in the left toolbar** that turns proxies on and off, with two clear states: active and inactive.

**Replaces from §19.5:** the per-film **Proxy / Original** switch on the player (the toolbar button is the one control now), and the `autoProxy` checkbox and its criteria (the project switch makes a proxy for every new cut, whatever the criteria say). **Kept from §19.5:** the offer bar for a cut that meets the criteria (4K, over 1.5 GB, a codec browsers struggle with, a playback error) while the project switch is off; progress and Cancel over SSE; the `proxies/` folder; Grab Frame from the original; originals never touched.

## 36.3 The presets

| Preset | Id | Short edge | Video, average / peak | Audio |
|---|---|---|---|---|
| 1080p High | `1080h` | 1080 | 10 / 14 Mbps | AAC 256 kbps |
| **1080p Low** (default) | `1080l` | 1080 | 4 / 5 Mbps | AAC 256 kbps |
| 720p High | `720h` | 720 | 3.5 / 4.5 Mbps | AAC 256 kbps |
| 720p Low | `720l` | 720 | 1.5 / 2 Mbps | AAC 256 kbps |

- **Size goes by the short edge**, so a 9:16 short gets a 1080- or 720-wide proxy, never a squashed one. Never upscaled: a source smaller than the preset keeps its size (made even) and only the bitrate changes.
- **Frame rate and duration** match the original (`-fps_mode passthrough`, `-vsync` before ffmpeg 5.1). yuv420p, faststart. A keyframe every 2 s, so a seek on a slow link fetches little.
- **Capped bitrate, not CRF.** `-b:v` is the average; `-maxrate` is **90% of the stated peak**, and `-bufsize` **half a second** of that. The card asked for the cap at the peak and a buffer of about 1 s. Measured: a 1 s buffer let 1080p Low peak at 5.74 Mbps on the high-motion clip (15% over, at the limit); with the cap at the peak and 0.5 s, a busy shot after a quiet stretch still ran a 1 s window up to 21% over on a real cut (Cloud on cloud), and a Windows nightly ffmpeg ran the test clip's 720p High 16% over. The 10% headroom brings every measured peak to within 4% of the stated one (36.8), so the stated peak is the rate a link must carry. Half a second still fits a 2 s keyframe comfortably.
- **Audio stays 256 kbps** in every preset: Red reviews mixes on proxies, and it costs almost nothing next to the picture.
- **1080p Low is the default**: it fits the 5–6 Mbps link measured above. 1080p Low and 720p High use about the same bandwidth on purpose: one keeps on-screen text sharp, the other keeps motion clean.

### Encoder: libx264, because VideoToolbox ignores the cap

The card asked for `h264_videotoolbox` on macOS where ffmpeg has it, if it honours the peak. Measured on the Mac mini (ffmpeg 9.0.2, a 16 s clip with a 3 s burst of full-frame noise after a still section, 1080p, 1 s windows):

| Encoder | Asked | Peak measured |
|---|---|---|
| h264_videotoolbox, `-b:v 4M -maxrate 5M -bufsize 5M` | 5 Mbps peak | **14.05 Mbps** |
| h264_videotoolbox, `-constant_bit_rate 1 -b:v 4M` | 4 Mbps constant | **16.03 Mbps** |
| h264_videotoolbox, `-b:v 10M -maxrate 14M` | 14 Mbps peak | **34.82 Mbps** |
| libx264 veryfast, `-b:v 4M -maxrate 5M -bufsize 2.5M` | 5 Mbps peak | 5.71 Mbps |

VideoToolbox doesn't honour `-maxrate` (nor its constant-bitrate mode) in this ffmpeg, and every preset is capped, so **every preset encodes with libx264 `-preset veryfast`**. It costs nothing in time: on the mini, libx264 veryfast made the 1080p clips in 0.9–1.6 s against VideoToolbox's 1.9 s.

The choice stays in code (`chooseEncoder`): VideoToolbox would be picked for a preset only when ffmpeg lists it **and** it is known to honour the peak, which no ffmpeg does today (`VIDEOTOOLBOX_HONOURS_PEAK = false`); a VideoToolbox encode that fails is retried once with libx264. Windows and Linux always use libx264.

## 36.4 One proxy per cut

- **Name**: `proxies/<film-slug>_<version>_proxy-<preset>.mp4`, e.g. `proxies/hero_v3_proxy-1080l.mp4`.
- **Record**: the version's `proxy` gains `preset`. Making a proxy at another preset **replaces** the old one: the new file is recorded, then the old file is deleted.
- **Older proxies**: a §19.5 proxy (`<slug>_<version>_proxy.mp4`, no `preset`) still plays, and shows as **"1080p (older)"**. It counts as not at the chosen preset, so "Remake" applies.

## 36.5 Project settings

In `project.json`:

- `proxyPreset`: `"1080h" | "1080l" | "720h" | "720l"`, default `"1080l"`.
- `alwaysProxy`: boolean, default off. **Replaces `autoProxy`**: on reading, `autoProxy: true` becomes `alwaysProxy: true`, and `autoProxy` is dropped on the next write.

`PUT /api/project/settings` takes either or both (and `autoProxy` as an old name for `alwaysProxy`, for older clients).

- **Turning the switch on** queues a proxy for the **latest version of each film in play** (not shelved, §26) that has none at the chosen preset. Older versions are made only when asked.
- **Changing the preset** deletes nothing. Ready proxies at another preset show "older quality". With the switch on, the latest version of each film is queued for a remake; older versions are not.
- **A new cut** (`POST /api/versions`, `rushes_add_version`), with the switch on, gets a proxy at the chosen preset straight away, whatever §19.5's criteria say. With it off, §19.5's `proxySuggested` and reason are returned as before, and nothing starts.

## 36.6 The queue

- **One job at a time.** An encode already uses every core libx264 is given, so a second one in parallel doesn't finish the pair sooner; it halves the speed of each and doubles the memory, and the desk's own ffmpeg work (Grab Frame, waveforms, probes) competes with both. One at a time also makes "newest first" mean what it says: the cut you just added is the next one done.
- **Order: newest cut first** (the version's `addedAt`), so the cut you're about to watch is ready first.
- **States**: `queued`, `running` (with %), then `done`, `failed` or `cancelled`. Every change goes to every open tab over SSE, as in §19.5. Cancel works on a queued job too (it simply leaves the queue).
- **One job per cut.** Asking again at the same preset joins the job already there. Asking at another preset replaces it: a queued job changes preset, a running one is cancelled and the new one queued.

Routes:

- `POST /api/videos/:video/versions/:version/proxy` takes an optional `{ preset }`, defaulting to the project's.
- `POST /api/proxies` (**Make proxies now**): queues the latest version of each film in play that has no proxy at the chosen preset. Returns the jobs.
- `DELETE /api/proxies` (**Delete all proxies**): cancels every job, then removes every proxy file and record. Originals are never touched.
- `DELETE /api/videos/:video/versions/:version/proxy` as before.

## 36.7 On the desk

### The Proxies tab

In the notes panel's tab list, after Activity (`web/src/ui/desk/ProxiesTab.tsx`), in the wide panel and the narrow drawer alike. Arrow keys move across all three tabs. Top to bottom:

- **Quality**: the four presets as a radio group, each with a one-line hint:
  - 1080p High: "Closest to the original, for a fast connection (≈14 Mbps)"
  - 1080p Low: "Sharp picture, plays on a slow connection (≈5 Mbps)"
  - 720p High: "Smooth motion on a slow connection (≈4.5 Mbps)"
  - 720p Low: "Plays almost anywhere, softer picture (≈2 Mbps)"

  The figures are the peaks, the rate a connection must sustain.
- **Always make proxies for this project**: an on/off switch (36.5).
- **Make proxies now (N)**: shown while the switch is off and N latest cuts lack a proxy at the chosen quality.
- **Test connection**: times a ranged fetch of the first 16 MB of the cut on screen (or the latest cut), from this browser, uncached, and says "About 5.8 Mbps from here", with a tick beside each preset whose peak fits in that speed. It never changes anything by itself.
- **The list**: each film's latest cut, plus every cut that has a proxy, newest first. Each row: film and version, then the state (none / queued / making with % and Cancel / ready / "older quality, remake?"), the preset and size, and **Make** (or **Remake**) and **Delete**.
- Under the list: the total disk the proxies use, and **Delete all proxies** (asks once more).

### The toolbar button

In the monitor's tool strip (`ToolStrip`), below the five tools with a small gap, on the Picture tabs only. A toggle with `aria-pressed`:

- **Active**: filled, accent colour. Tooltip "Proxies on · playing 1080p Low". Key **P**.
- **Inactive**: outlined. Tooltip "Proxies off · playing originals".

Remembered **per browser, per project** (`localStorage` `rushes:proxies:<project id>`), default off: each viewer's connection differs (the mini's own screen wants originals; a laptop on the relay wants proxies).

- **On**: every cut with a ready proxy plays it; a proxy at an older preset still plays until it's remade. A cut with no proxy plays the original, and the bar under the player says **"No proxy for this cut"** with **Make proxy** (at the project's preset).
- **The §19.5 offer** (project switch off, a cut that meets the criteria): **Create proxy** makes it at the project's preset, and turns Proxies on **once it is ready**, so it plays. Cancelled or failed, nothing changes and the offer returns, as in §19.5. (Turning Proxies on at the press would replace the offer with "No proxy for this cut" after a Cancel.)
- **Off**: originals everywhere.
- **Swapping** keeps the playhead and whether it was playing.
- Notes, timecodes and frame numbers are the same either way. **Grab Frame always reads the original**.

The per-film Proxy / Original switch on the player is gone. The More menu's old "Make lighter copies of new cuts automatically" row is now **Proxies**, which opens the tab. **P** is listed in Keyboard shortcuts.

### The stall hint

With proxies off, when the player stalls twice within 30 s for 1 s or more each (a `waiting` not followed by `playing` within 1 s; a wait while seeking doesn't count), one line shows under the player: **"Playback is stalling. Turn on proxies?"** with **Turn on proxies**, which turns the toggle on and makes a proxy for the cut if it has none. Once per cut per session (dismissable). Rushes never switches on its own.

## 36.8 Measured

**Encode check** (`test/server/proxyEncode.test.ts`, real ffmpeg; skipped without it): a 5 s 1920×1080 high-motion clip (`testsrc2` under full-frame noise that changes every frame), encoded at each preset; the peak is the most bits in any 1 s window of video packets (ffprobe). It must be within 15% of the stated peak, and the average within 15% of the preset's. The same test checks portrait, square and smaller-than-preset sizes. On the Mac mini (libx264, ffmpeg 9.0.2), final settings:

| Preset | Stated peak | Test clip avg / peak (Mbps) |
|---|---|---|
| 1080p High | 14 | 8.83 / 11.89 |
| 1080p Low | 5 | 3.33 / 4.41 |
| 720p High | 4.5 | 3.11 / 4.04 |
| 720p Low | 2 | 1.17 / 1.52 |

The test holds ffmpeg to 2 threads so its encodes don't starve the timing-sensitive tests running beside it on CI. x264 with fewer threads sits closer to its average: on the mini at 2 threads the clip measures 10.32 / 14.94, 4.10 / 5.20, 3.58 / 4.42 and 1.51 / 2.04, so at most 7% over a stated peak on a small machine.

With `-maxrate` at the full peak (the first build), the same clip measured 12.01 / 4.57 / 4.21 / 1.71 on the mini and 14.32 / 5.68 / **5.22** / 2.13 on CI's Windows nightly ffmpeg, which is what moved `-maxrate` to 90%.

**Hands-on** (26 Nov, the Mac mini, a copy of Cloud Engines Shorts served from the branch on port 4598): turning the switch on at 1080p Low made the latest cut of all six films in 25 s, one at a time; changing to 720p Low showed all six as older, queued them and remade them in 17 s. Toggling Proxies while playing swapped the file and kept playing from the same place, four times out of four. The stall hint showed after two simulated stalls, and its button turned Proxies on and played the 720p Low proxy. The originals are 1080p H.264 at 9–55 Mbps. Final settings, per film (time is ffmpeg alone):

| Film | Original | 1080p Low: size, time, avg / peak | 720p Low: size, time, avg / peak |
|---|---|---|---|
| Engine sizes v14 | 22.2 s, 124 MB, 44.6 Mbps | 8.9 MB, 2.0 s, 2.93 / 4.50 | 3.7 MB, 1.4 s, 1.08 / 1.73 |
| Cloud on cloud v9 | 28.0 s, 33 MB, 9.3 Mbps | 12.5 MB, 1.7 s, 3.31 / 5.20 | 5.2 MB, 1.2 s, 1.22 / 2.00 |
| North America v4 | 30.2 s, 202 MB, 53.5 Mbps | 10.5 MB, 2.4 s, 2.78 / 4.80 | 3.7 MB, 1.8 s, 0.97 / 1.84 |
| EU only v9 | 33.0 s, 226 MB, 54.7 Mbps | 12.4 MB, 2.8 s, 2.75 / 4.42 | 5.2 MB, 2.0 s, 1.00 / 1.73 |
| Engine power v9 | 23.9 s, 117 MB, 39.2 Mbps | 8.4 MB, 1.9 s, 2.53 / 4.22 | 3.3 MB, 1.3 s, 0.83 / 1.69 |
| Always running v17 | 24.8 s, 138 MB, 44.6 Mbps | 9.4 MB, 1.8 s, 2.76 / 4.15 | 4.2 MB, 1.5 s, 1.07 / 1.49 |

Every peak is within 4% of the stated one. (With the first settings, Cloud on cloud at 1080p Low peaked at 6.03, 21% over, in the second from 24.3 s.)
