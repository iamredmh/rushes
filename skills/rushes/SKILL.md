---
name: rushes
description: Review video work with the user in Rushes, a local review desk. Use when you've rendered a cut, written a VO script, recorded voice reads, music beds or SFX passes and the user should review them, or when the user says they left notes, pressed Send to agent, or pastes a Rushes batch prompt.
---

# Rushes

Rushes shows your work to the user stage by stage (script, picture, voiceover, music, sound effects, mix). The user leaves timecoded notes that you act on.

1. Register what you made:
   - `rushes_add_version` for a render;
   - `rushes_set_script` for the VO script. It merges by `id`, so send only the sections you changed; sections you leave out are kept. `rushes_get_script` reads the whole script;
   - `rushes_add_variant` for each voice read, music bed or SFX pass. Voice reads carry `stage: "voice"` and a `round` (its name — reads in one round are compared side by side; a new direction gets a new round); say what the read is, or what changed, in `description`. Music and SFX carry `meta.description` for their lane card;
   - `rushes_set_shots` for the storyboard's shots, once you have the first cut; send new timings when a later cut moves them.
2. Call `rushes_open` and tell the user it's ready. Each project's dashboard lives at its own address, `/p/<id>/`.
3. When the user sends a batch, call `rushes_get_batch` and fix every note in it. A note carries the `shot` it falls in; on an audio stage, call `rushes_get_picks` first. Its `on` says what it's about: `"<lane>/<variant>"` for a bed, pass or voice read (on Voiceover the lane names the round), `"<lane>/<variant>:<cue>"` for an SFX cue, `"vo"` for the Mix VO lane, or `null` for the whole mix; older notes may carry a section id or `"<section>:<take>"`. On Music, Sound effects and Mix treat `marks` (e.g. "Fall", "Quieter 3 dB") as part of the note; Voiceover notes carry none — they're Whole (`Speaker`, `Pacing`, `Tone`, `Overall`) or Point (`Fix this`, `Keep this`) instead. Picks are set from the dashboard only — no tool or CLI command sets one.
4. Register the new cut with `rushes_add_version`. On a locked video the reply carries a `warning`.
5. Reply to all the notes in one `rushes_reply` call. For each note set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`.
6. For script batches: when a section's `proposed` differs from `current`, adopt it with `rushes_set_script`, sending just that section with its `id`. If voiceover already exists, re-record the picked voice with the corrected script and register it with `rushes_add_variant` as a new read in a new round.
7. Lock picture with `rushes_lock_picture` only when the user says picture is locked; `version: null` unlocks it.

Save renders, voice reads, beds and passes under the project's `renders/`, `audio/voiceover/`, `audio/music/` and `audio/sfx/` folders. Screenshots the user grabs with G or the camera button land in `screenshots/`. Use `rushes_list_assets` (optional `kind`) to find a file the user refers to but hasn't given you a path for, such as "use the screenshot I just took".

The **Assets** tab is a library: Screenshots, Cuts, Voiceover, Music, Sound effects, Scripts & docs, Images, Captions, Exports, Delivery and Edit files. Top-level `.md`, `.txt`, `.pdf`, `.srt` and `.vtt` files, and anything in `exports/`, are found automatically. Register everything else with `rushes_add_file` (`kind`, `file`, optional `name`, `note`, `video`): deliverables and platform exports as `delivery`, NLE project files as `edit`, storyboards/references/logos as `image`, briefs as `doc`. When the user wants to share notes, call `rushes_export_notes` — it writes a dated Markdown file to `exports/` and returns the path.

Rushes has sixteen tools: `rushes_open`, `rushes_status`, `rushes_add_version`, `rushes_add_variant`, `rushes_set_script`, `rushes_get_script`, `rushes_add_take`, `rushes_list_notes`, `rushes_list_assets`, `rushes_get_batch`, `rushes_reply`, `rushes_get_picks`, `rushes_set_shots`, `rushes_lock_picture`, `rushes_add_file` and `rushes_export_notes` — `rushes_add_take` stays only for compatibility and isn't used for voiceover. The full contract is in `AGENTS.md` at the package root.
