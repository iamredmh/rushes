# §35 Notes follow the film, and go one way

## 35.1 The problem

Red, 20 Nov 2026, on Five views: notes made on the Voice tab didn't show on the Timeline, where he reviews the voice with the picture big; the Voice tab has little room. And note `n_db9dcc` got an agent reply asking him to "unlock the keychain, or run `elevenlabs auth login`": the desk showed **Needs you**, an **Answer Claude Code** box and a top-bar chip "Claude Code has a question". Rushes is for marking up the work; Send to AI exists to push notes over without copying them. A question about the setup belongs in the agent's own session, not on a note.

## 35.2 Decision (Red, 20 Nov 2026)

1. **Every film's notes are visible from its Timeline.**
2. **Notes go one way.** The user writes notes; the agent says what it did. The agent never asks the user anything in Rushes.
3. **When the agent is blocked**, it raises one **Attention** item in Activity, which takes the user back to the agent's conversation.

Replaces §28.5 (the user's answer on a note goes back to the conversation as its own turn, rulings R11 and R13, the Needs you state, the reply box, the "question" phase and its notification) and any text that has the agent ask on a note.

## 35.3 The Timeline lists the film's notes from every tab

What it showed before: the film's Picture and Mix notes (for the format on screen), plus Voice, Music and Effects notes only on the take in use on that row (`takeNotesOf`, `web/src/ui/desk/useTakeSelection.ts`). A note on any other take, and every Visuals note, showed only on its own tab.

Now, on the Timeline (with a cut, or the no-cut timeline):

- **The list holds** the selected film's Picture and Mix notes as before, and **every** Voice, Music and Effects note on the film (`timelineNotes`, `web/src/tabNotes.ts`), and the shared Visuals notes. Script notes stay on Plan. Nothing from another film (§31).
- **A tab label** on each note from another tab: "Voice · Eliza, read 3", "Music · Bed B", "Effects · Pass 2 · Whoosh", "Visuals · Shared". A Voice, Music or Effects note on a take that isn't the one in use reads "(not in use)" after the take. Picture notes carry no label (they are the Timeline's own), and Mix notes keep the label they had.
- **Clicking a note's time** seeks the timeline to it, whatever its tab: a take plays from the cut's start, so a note's time on a take is the same time on the timeline, in use or not. A Visuals note has no time.
- **The To do / Done / All filter** covers all of them.
- **Markers** on the sound rows are unchanged: only notes on the take in use are drawn on its row.
- **Counts are unchanged**: the Notes tab count, the Review tab dots and the Film menu still count what they counted.

**Voice, Music and Effects** keep their own lists. An **All tabs** switch beside the filter (off by default, remembered per browser) shows the same film-wide list there, labelled the same way.

## 35.4 Notes go one way

On the desk:

- No reply box on a note, no **Needs you** badge, no "<agent> has a question" chip state and no notification for it. The phase "question" is gone: a run that ends is "finished".
- A note's thread shows the agent's replies, read-only. Answers a user wrote on a note before 0.14.0 are kept in `notes.json` and not shown.
- Mark done, and writing a new note, stay. **A new note on the same moment is how the user follows up.**
- **Permission asks are unchanged** ("Allow once / Always" cards are permission checks, not conversation; §33's Auto removes most).

On the server:

- The follow-up turn (`src/server/agent/followUp.ts`), the `user-reply` event and `POST /api/notes/:id/replies` are removed (404). A turn is always a batch.
- **When a turn ends**, every note in its batch still with the agent goes back to to do, whether or not the agent replied on it. Its replies stay.
- **Migration** (on start, once, idempotent): a note that was in the old Needs you state (still sent, the last word in its thread the agent's) goes back to to do, keeping its replies. Old `by: "user"` replies are ignored on read.

For the agent (`rushes_reply`, the batch prompt `AGENT_LINES`, AGENTS.md, the skill, README):

- A reply says only **what was done**, in a sentence or two.
- A note it couldn't do: one line saying so, leave the note to do, and raise an Attention item if the user has to do something outside Rushes.
- **Never ask the user a question in Rushes**, about the work or the setup. A note it doesn't understand: do its best reading and say what it did; the user writes a new note if that wasn't it.
- `rushes_reply` never had a question flag; its description now says the above. A reply that ends in a question mark is stored like any other: Rushes doesn't parse prose.

## 35.5 Attention items

**A new MCP tool, `rushes_attention`** (`POST /api/attention`), not a field on `rushes_reply`: it is raised when the agent can't go on without the user outside Rushes (a sign-in, a missing key, a missing file), which may be before or apart from any note, and it is not a reply on what was done. Keeping it separate keeps `rushes_reply` to one meaning. It takes `title` (one line, e.g. "ElevenLabs sign-in needed on this Mac"), optional `note` and optional `film`. Its film is the note's; without a note, the film named, or the only one (§31.6).

**Where it lives:** a Change Log line of a new kind, `attention`, on that film, with the note's id and `resolved` (null until it clears). Repeating the same title on the same film while one is open adds nothing.

**On the desk (Activity):**

- The line has a warning icon and the desk's warning colour, and reads as needing the user, never as done.
- While one is unresolved on the film, the Activity tab's dot is the warning colour (whether or not it has been seen).
- The top bar shows nothing new.
- **Dismiss** clears it.

**It clears** when its note is marked done (by the agent or the user), when the note gets a reply naming the version it was fixed in (`fixVersion`), or on Dismiss. A cleared item stays in Activity as an ordinary line.

**Clicking it** goes back to the agent's conversation, the session id in the project's `agent.json` (`POST /api/attention/:id/open`):

- **On the same computer** as the browser: Rushes opens a terminal in the project folder running `claude --resume <session-id>`, or `codex resume <session-id>`, with §34's opener (`src/server/agent/terminal.ts`; Terminal on a Mac, a Command Prompt on Windows, the first terminal found on Linux).
- **Otherwise**, or if no terminal opens: a small panel with that command, a **Copy** button and "Run this on <short hostname>, in <project folder>".
- **No conversation kept** (Send to AI never ran here): the panel says so and shows the project folder.

"Same computer" is proven, not guessed: a tunnelled desk (Red's, reached from another Mac) also arrives from 127.0.0.1. Each server start makes a random key, written only to the project's `.rushes/server.json`. When Rushes itself opens the browser (`rushes open`, `rushes_open`), it adds `#here=<key>` to the address; the desk keeps it for that tab and sends it with the click. The terminal opens only when the key matches and the request comes from this computer. A desk typed into a browser by hand gets the panel.

**Checked against the installed CLIs (20 Nov 2026):** Claude Code's ACP session id is the Claude Code session (`~/.claude/projects/<folder>/<id>.jsonl`), and `claude --resume <id>` opens it when run in the project folder. Codex's ACP session id is its thread id (`~/.codex/sessions/…/rollout-…-<id>.jsonl`), and `codex resume <id>` opens it.

## 35.6 With one film

Everything above applies; the Timeline's list simply covers the one film.
