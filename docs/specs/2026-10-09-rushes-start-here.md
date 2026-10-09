# Rushes: start here (§24)

Status: DRAFT, 9 October 2026. Red accepted the recommendations in 24.9 the same day and asked for a mockup (`2026-10-09-rushes-start-here-mockup.html`, six states to click through). The mockup is waiting for Red's OK; nothing is built. This file extends `2026-10-02-rushes-design.md` and follows §23 (sound-effects cue layers). The number is provisional.

## 24.1 The problem

Rushes is a review desk, so today it enters a project late. The agent has already written a script, made a cut and generated audio before anyone opens it. By then the big decisions (length, tone, what the film is for, which shots it needs) were made in a chat the user could not see, mark up or approve.

The README says "use Rushes as my review tool". It should say "start your film in Rushes". Red's own working method already does this: no build before an approved beat sheet and storyboard (`/motion-brief`). The start-here flow moves that gate into Rushes, where the user can see and mark it.

Rushes is still not an editor and does not generate media. A film starts in Rushes as a plan the user approves. The agent then builds in whatever tool it likes.

## 24.2 The flow, from the user's side

```
say "start a new film in Rushes"        (or: npx rushes new my-film)
   |
   v   BRIEF        the agent asks at most three questions, each with a recommended answer
   |                and writes the brief. You edit it, then approve it.
   v   SCRIPT       existing tab. Lines and fit bar. You edit, approve section by section.
   v   STORYBOARD   shot cards: name, length, what happens, a still. You note and approve.
   |
   v   "Ready to build"  appears when all three are approved. Copy prompt for the agent.
   |
   v   The agent builds outside Rushes (HyperFrames, Remotion, anything) and registers the cut.
   v   PICTURE, VOICEOVER, MUSIC, SOUND EFFECTS, MIX, ASSETS   exactly as today.
```

Nothing after the gate changes. A cut that arrives inherits the approved shots, so Picture notes already say "Shot 03 · Window rises in".

## 24.3 Decisions (proposed)

1. **Two new tabs at the front: Brief and Storyboard.** Order becomes Brief, Script, Storyboard, Picture, Voiceover, Music, Sound effects, Mix, Assets. Script sits between them because Red writes the script first and then draws it (pipeline order in `CLAUDE.md`).
2. **The agent never approves.** The user approves the brief, each script section and each storyboard shot in the dashboard only, the same rule as picks and picture lock. No tool or CLI command sets an approval.
3. **The gate is soft.** `rushes_status` reports `build: { ready, waitingOn }`, the header shows a "Ready to build" chip, and `rushes_add_version` replies with a `warning` when the plan is not approved. There is a precedent: a cut registered on a locked video already carries a warning. Rushes cannot stop an agent and should not pretend to. The user can say "just build it".
4. **The brief is short.** Working title, what it is for in one sentence, audience, length target, formats wanted (ratios), tone and references, must include and must avoid, and what it will be built with (free text, may be blank). Seven short fields, not a form of thirty. The agent drafts it from the interview; the user edits it in the page.
5. **A storyboard shot is a Shot with a description and a still.** Same `name`, `tag` and ordering as §14.4, plus `length` (planned seconds), `description`, optional `frame` (an image file registered as an asset) and a status: draft, approved or flagged, like script sections. The plan lives on the film, before any version exists.
6. **Shots carry forward.** When the film's first version is registered it starts with the plan's shots, laid out by cumulative length. After that, `rushes_set_shots` moves them to real timings as today. Planned and actual are not compared in this section.
7. **Rushes does not generate stills.** The agent makes frames with whatever tool it uses and registers them (`rushes_add_file`, kind `image`). §3's out-of-scope line stands.
8. **Questions are few and always recommend.** The skill tells the agent to ask only what changes the film, to give a recommended answer with its trade-off ("30 seconds fits a feed, 60 leaves room for the demo"), and to end with the next step.
9. **Existing projects are untouched.** A project that began with a cut keeps working. Its Brief and Storyboard tabs are locked and explain themselves like any other locked tab (§19.1), with a copy-prompt, never a nag.

## 24.4 What each new tab shows

- **Brief.** One page. Each field is the agent's draft on the left and the user's version on the right, the way Script rows work, so an edit is visible to the agent. One **Approve** at the bottom. A short list of reference files (brand folder, screenshots, a competitor film) that the agent attached.
- **Storyboard.** A row of shot cards: `01 · 3.0 s`, name, tag, the still, then the description. Click a card to open it large. Notes down the right as on other tabs; a note's `on` is `shot/<n>`. Each card has a tick to approve. A strip at the foot totals the planned length against the brief's target.
- **Header chip.** Shows what is still open ("Brief, 2 script lines"), and becomes "Ready to build" with **Copy prompt for your agent** when nothing is.

Layout, labels and icons follow Red's rules: Rushes' own style, icon buttons with tooltips, very few labels. A mockup comes before any plan.

## 24.5 Data

All additions are optional with defaults, so every existing project loads unchanged.

```ts
// VideoSchema gains
brief: BriefSchema | null  = null
plan:  PlanSchema  | null  = null

BriefSchema = {
  title, purpose, audience, length: seconds | null,
  formats: string[],              // ratio labels, e.g. ["16:9", "9:16"]; feeds §21 later
  tone, include, avoid, builtWith,
  references: string[],           // asset paths or links
  approvedAt: string | null,      // set from the dashboard only
}

PlanSchema = {
  shots: { n, name, tag?, length, description, frame?: string, status }[]   // max 60, sorted and numbered by the server
}
```

A film may exist before its first cut. It has `versions: []`, `brief` and `plan`. **To check before the plan is written:** that Picture, the Assets library, the version menu and the film pills all cope with a film that has no versions. I have not tested this.

## 24.6 Agent side

New or changed:

| Tool | Does |
|---|---|
| `rushes_set_plan` | Sets the brief fields and/or the storyboard shots for a film. Merges by field and by shot `n`. Cannot set an approval |
| `rushes_get_plan` | The brief, the shots, their statuses and the user's edits |
| `rushes_status` | Gains `build: { ready, waitingOn }` |
| `rushes_add_version` | Gains a `warning` when the plan is not approved |

That is 24 tools. CLI: `rushes new <folder> [--name]` (does what `init` does, plus the recommended folders and a `brief.md`, then opens the desk), `rushes plan [--json]`, `rushes set plan <file.json>`.

The skill gains a "Starting a film" section: the interview rules (24.3 item 8), "do not build until `build.ready`", "register the cut with `rushes_add_version`; the planned shots come with it", and one naming convention worth stating once: **name each scene after its planned shot** (for HyperFrames, one sub-composition per shot). Then a Picture note's shot already points the agent at the file, with no adapter and no change to Rushes.

The README's first instruction becomes: "Tell your agent: start a new film in Rushes."

## 24.7 What stays the same

- Rushes still reviews. It does not edit, render or generate.
- Notes, batches, replies, `fixT`, picks, picture lock, formats, the Change Log and every existing tab.
- Any tool can build the film. Nothing here is specific to HyperFrames or Remotion.
- No account, no keys, one local server, plain files.

## 24.8 Not in this section

- Templates per video type (launch reel, explainer, testimonial). The interview is one generic one. Type-specific packs belong in a user's own skills.
- Importing an existing HyperFrames or Remotion project into Rushes. A render registers as a cut like any other.
- Comparing planned shots with the real cut.
- A brief shared across several films in one project.

## 24.9 Questions, and what Red chose (9 October 2026)

Red went with the recommendation on each.

1. **Two tabs, Brief and Storyboard.** Not one "Plan" tab: the script sits between them.
2. **The tab keys are renumbered 1 to 9** in workflow order. Assets moves from 7 to 9. README and the shortcut list change with it.
3. **The gate is soft:** a chip, `build.ready` in `rushes_status`, and a warning from `rushes_add_version`.
4. **The seven brief rows stay as drafted,** with brand and voice files as the `references` list.
5. **Existing projects show Brief and Storyboard locked and explained,** with a copy-prompt, never a nag.

## 24.10 Build order

Each step is usable on its own and ends at Red's OK before the next.

1. **Front door, no UI.** Built: `rushes new <folder>` (folders, project, a `brief.md` template that Assets already finds), the "Starting a film" section in the skill and `AGENTS.md`, and a README that leads with starting a film. Approval is the user saying so in chat; the agent then changes the `Status:` line in `brief.md` or `storyboard.md`. The folder argument is required (a bare `rushes new` prints its usage), and a folder that is already a project is refused.
2. **Brief tab.** The `brief` data, `rushes_set_plan` for the brief, approval in the dashboard, the header chip.
3. **Storyboard tab.** The `plan` data, shot cards, notes on shots, approvals, `build.ready`, and shots carried into the first version.

Tests as elsewhere: unit for the schema, merge and approval rules (the agent cannot approve); Playwright for each tab in Chromium and WebKit; a check that an old project loads unchanged.
