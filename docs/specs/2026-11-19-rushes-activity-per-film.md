# §30 Activity per film

## 30.1 The problem

In a project with several films, the notes panel's Notes list was already per film, but **Activity** was one project-wide Change Log. On Red's Caffeine project (Meet your agents and Five views, 19 Nov 2026), Five views' Activity showed Meet your agents' takes, its notes being sent and the agent's replies to them. Many lines didn't say which film they were about: "4 notes sent from Picture", "Claude Code started on 4 notes", "Agent replied to 4 notes", a take added. Asking for similar changes on both films, Red couldn't tell which film a line was about, and second-guessed whether he'd asked twice.

## 30.2 Decision (Red, 19 Nov 2026)

What belongs to a film shows only on that film. Activity on a film shows that film's lines and the project's own (the script, the brief, files, lines written with no film), never another film's. R18 (a row about another film switches to it) is replaced: such a row isn't shown on the other film.

## 30.3 Lines carry their film

- **Notes sent**: a Send whose notes are on several films writes one line per film, counting that film's notes and naming the tab they came from ("2 notes sent from Picture"). Script edits go on the line for no film.
- **Replies**: one line per film.
- **The agent's run lines** (Send to AI: started on / finished / ended / couldn't finish) are written once per film the batch's notes are on, each with that film's count. The live strip still tells the run as one.
- **Merging**: a line only merges into an earlier line about the same film, so two films' cuts in a burst are two lines, each naming its film.

## 30.4 Older lines

A line written before this has no film. Activity works it out where it can: a reply line's `notes:<ids>` gives the films of those notes, and a take line's `<lane>/<variant>` gives the films the take is on. A line it can't place (an old "notes sent" or run line) stays on every film.

## 30.5 The desk

`ActivityList` filters to the film on screen (`onFilm` in web/src/lib.ts), and its footer counts what is shown. The live strip leaves out the run's lines about a note on another film. With one film, nothing changes.

## 30.6 Found in testing, not changed

- (Resolved by §31.2.4: what is on no film is the first film's.) In a project that gains a second film, takes on no film stop being on any film (`onFilm` in core/schema.ts: on no film means on the only film, or on none). The first film's voice, music and effects then vanish until each is put on a film. That's an existing rule; raised with Red.
- "Before the log" (audio from before the log began) is still listed for the whole project.
