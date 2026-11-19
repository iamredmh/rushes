# §29 Auto-balance

## 29.1 The problem

Takes arrive at whatever level their generator made them. Mix played each one as it came, plus a fader of −24 to +6 dB, so nothing checked the sounds against each other. On Red's Meet your agents mix (19 Nov 2026) the voice was clean, but the music sat 5 to 9 LU under it for most of the film and the effects about 20 dB under it: they couldn't be heard, and +6 dB couldn't bring them back. Red: the tracks need to be "registered against each other". With voice, the voice rings true and isn't drowned out. Without voice, the music holds a set level and the effects are audible, since they're there for a reason.

## 29.2 Decisions (Red, 19 Nov 2026)

- A louder house balance, written once (`src/core/balance.ts`) and used three ways: the desk's Balance button, an automatic balance when a take is put in use, and `rushes balance` for the agent that makes the sound.
- Rushes auto-balances, so the user doesn't have to.
- The faders go to +12 dB (from +6), so a quiet take can reach the balance.

## 29.3 The rule

The voice is the reference: its fader stays at 0.

- **Music**: level with the voice's integrated loudness, then pulled back so that on every spoken line the voice clears it by at least 1 LU **in the speech band** (high-pass 300 Hz, low-pass 4 kHz). A full-band check is the wrong measure: the bed's low end counts there but doesn't cover the voice. On Red's mix, full-band numbers said the voice was under the music at the fader he chose, but it was clear by ear. With no voice in use, the music goes to −20 LUFS integrated.
- **Effects**: each hit is found in the pass (everything within 30 dB of its loudest moment, hits joined across 0.3 s), and the pass is moved so the median hit's momentary peak sits 1 dB under the music's short-term level at that moment, after the music's own move. With no music, hits sit 6 dB under the voice; with neither, at −20 LUFS.
- **No clipping**: the balanced mix is measured once; if it would peak over −1 dBTP, every sound comes down by the overshoot together (voice included), to the 0.5 dB step.
- Levels go on the fader's 0.5 dB step and are clamped to −24..+12. A sound that hits the end is reported: that take needs re-rendering at a different level.

Calibrated by ear on Meet your agents: for the Sonnet variation bed and the louder soft-touch pass, the rule gives music +2.5 dB and effects +10 dB. Red had set +3.5 dB and settled on +10 dB.

Spoken lines are frames within 20 LU of the voice's integrated loudness, joined across pauses of 0.4 s, at least 0.3 s long.

## 29.4 Data

`picks.json`: each film's entry (and the project-wide set) gains `balanced: { levels, at }`, the levels the last balance set. The levels are **the balance's own** while they equal `balanced.levels`, or while none are set and nothing has been balanced. An older Rushes ignores the field (loose objects).

## 29.5 Server

- `POST /api/mix/balance { video? }`: reads each take in use with ffmpeg ebur128 (full band, plus the speech band for voice and music), applies the rule, writes the film's levels and `balanced`, logs one Mix line ("Mix balanced for <film>: …", replaced by the next one), and returns `{ available, levels, report, summary, picks }`. Without ffmpeg: `{ available: false, summary }`, nothing written. A film that isn't there is a 404.
- **Automatic**: when `PUT /api/picks` changes the take in use for a sound (and carries no levels), and the film's levels are the balance's own, the server balances again in the background, one run at a time per film. Inside the write it checks again: if a fader was moved or another take was picked while ffmpeg ran, nothing is written. On for `startServer` (`RUSHES_AUTO_BALANCE=0` turns it off: the browser tests); off for a bare `createApp`.
- Readings are cached per file, mtime and band.

## 29.6 The desk

A **Balance** button after the loudness readout in the transport (Timeline, and a project with no cut). It's pressed (accent) while the levels are the balance's own. A press drops any fader save still waiting, balances, and shows the summary as a toast; the faders follow by the usual live update. Moving a fader by hand releases the button and stops the automatic balance until it's pressed again.

## 29.7 CLI and agents

`rushes balance [--voice F] [--music F] [--sfx F] [--json]` runs the same rule on files, with no server: the dB move for each, and the summary. AGENTS.md and the Rushes skill tell agents that the levels may be the house balance, to render new takes so the moves stay near 0, and to apply `levels` to a mix they render themselves.

## 29.8 Not in this release

Automation over time (the fader is one level per take). A bed whose own arrangement is quiet in one half and loud in the other still needs re-arranging or re-rendering. Balancing when a take's file is re-rendered in place.
