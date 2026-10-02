---
name: rushes
description: Review video work with the user in Rushes, a local review desk. Use when you've rendered a cut, written a VO script, generated VO takes, music beds or SFX passes and the user should review them, or when the user says they left notes, pressed Send to agent, or pastes a Rushes batch prompt.
---

# Rushes

Rushes shows your work to the user stage by stage (script, picture, voiceover, music, sound effects, mix). The user leaves timecoded notes that you act on.

1. Register what you made:
   - `rushes_add_version` for a render;
   - `rushes_set_script` for the VO script;
   - `rushes_add_take` for each VO take;
   - `rushes_add_variant` for each music bed or SFX pass.
2. Call `rushes_open` and tell the user it's ready.
3. When the user sends a batch, call `rushes_get_batch` and fix every note in it.
4. Register the new cut with `rushes_add_version`.
5. Reply to all the notes in one `rushes_reply` call. For each note set `status: "done"`, a one-line `reply`, `fixT` (when the fix is visible in the new cut, in seconds) and `fixVersion`.
6. For script batches: when a section's `proposed` differs from `current`, adopt it with `rushes_set_script`, keeping the section's `id`. Then make new takes for it.

The full contract is in `AGENTS.md` at the package root.
