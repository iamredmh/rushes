# §31 Everything on the desk belongs to a film

## 31.1 The problem

On Red's Caffeine project (two films: Meet your agents, Five views; 19 Nov 2026), Plan › Script on Five views showed Meet your agents' script. An audit found the same leak on most surfaces: there is one `script.json`, one `brief.md` and one `storyboard.md` per project; the Assets tab ignores the film in the top bar; Send to AI sends every film's notes; the Activity dot, the Review tab to-do dots and the Plan overview count every film; notes, takes and files with no film show on every film (notes) or on none (takes); and the API and MCP tools that list notes, the log, assets and the script take no film.

## 31.2 Decision (Red, 19 Nov 2026)

The reason to switch films is to work on one film at a time: **with a film selected, every tab shows only that film's material.** In detail:

1. **Script, brief and storyboard are per film.** Each film has its own. A project's existing ones belong to its first film; any other film starts empty and is filled by Red or the agent.
2. **Send to AI sends only the selected film's notes.** The Send count, the batch and its prompt cover that film alone.
3. **Visuals stay project-wide** (they are campaign material). This is the one exception, and it is shown as shared, not as a leak.
4. **Nothing is on no film.** Notes, takes and files that carry no film are assigned once to the project's first film. From then on everything new is made on a film.
5. Project-wide by nature, unchanged: project name, fps, auto-proxy, agent setup and permissions.

Replaces: §24.12 (one storyboard.md per project), §30.2's "the script, the brief … are the project's own" lines (script and brief lines now belong to a film), the "Send covers every film in play" rule (design.md:179, AGENTS.md:121), and `onFilm`'s "on no film means on the only film, or on none".

## 31.3 Where things live

- **Script:** `script.json` schema 2 holds one script per film: `films: { [videoId]: { wordsPerSecond, sections, sectionCounter } }`. A schema 1 file is read as the first film's script and written back as schema 2.
- **Brief and storyboard:** the first film keeps `brief.md` and `storyboard.md` at the project root, so existing projects and agent sessions keep working. Every other film's are `films/<film-id>/brief.md` and `films/<film-id>/storyboard.md`. Their baselines (`brief.json`, `storyboard.json`) are kept per film too. One helper names a film's paths; nothing else builds them.
- **A project with no film yet** (Plan before the first cut) works as now: its plan files are the root ones, and they become the first film's when it is made.
- **Storyboard shots** seed only their own film's first cut.

## 31.4 The one-time move (on load, idempotent)

On opening a project with two or more films, Rushes assigns the first film (`project.videos[0]`) to: notes with no `video` (except visuals notes), takes/variants on no film, files with no `video` (except visuals), and script sections (by reading schema 1 as that film's). It writes one Activity line saying what moved and to which film. Old log lines keep no film and stay where §30.4 puts them.

## 31.5 The desk

- The selected film is in the URL (`?film=<id>`), so a reload or a shared link keeps it.
- Plan (Brief, Script, Storyboard, the Ready to build overview and its dots), Review (timeline, the Voice/Music/Effects tabs, their counts, to-do dots and unlocking), notes, Activity (the list and its "new" dot), Assets and Send all follow the selected film.
- Assets defaults to the selected film. Visuals show on every film, marked "Shared". An "All films" view stays available but is never the default.
- A note, take or file is always made on the selected film.

## 31.6 The API and MCP

- `GET /api/notes`, `/api/log`, `/api/assets`, `/api/script`, `/api/brief`, `/api/storyboard` and status take `?video=`. Writes to the script, brief and storyboard name their film.
- MCP tools that read or write a film's material take `film` (the film id or name). With one film it may be left out. With several, leaving it out is an error that lists the films. A batch carries its film, so an agent working a batch uses that.
- AGENTS.md and the skills say where each film's plan files are and that a batch is about one film.

## 31.7 With one film

Nothing a user sees changes: the same files, the same paths, the same counts.
