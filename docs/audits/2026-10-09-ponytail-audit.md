# Rushes audit, 9 October 2026

Status: written against 0.4.0 (99857a9). The commits that carry this file fix findings 2, 3 and 4, fix 1 in part, and remove `docs/plans` (finding 11). Everything else is open. Line numbers are for 99857a9; `git log` shows what has landed since.

## How it was done

The audit prompt is `/ponytail-audit` from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT), a one-shot, read-only review that maps the code first, then looks for bugs, risk, scale, missing tests, speed and lean, and refuses any finding without a concrete failing case. Nothing from ponytail was installed. Three read-only agents followed that prompt over three parts: `src/core`, `src/mcp`, `src/cli` and `src/setup`; `src/server` and `web/`; and tests plus whole-repo duplication. They changed nothing and ran no test suite. Where a finding needed proof they ran a small throwaway script against a copy of `src/`; those scripts are not kept here.

The load assumed: one person on one machine, with one or two agent processes writing at the same time. Concurrent writers are in scope; many users are not.

Checked by hand against the code: 1, 2, 3, 4, 6 (the `--dir` part), 7, 8, 11 and, in 14, `Store.backup`. The rest are as the audit reported them and have not been re-checked.

## Done

| # | Finding | What was done |
|---|---|---|
| 1 | An older Rushes deletes fields a newer one saved | **In part.** Every stored object is now declared through `fileObject()` in `src/core/schema.ts`, so a file written back keeps fields this version doesn't know, at any depth. That protects the next release; versions already out still drop fields. Not done: refusing to talk to an older running server. The specs accept it (§23: an older server "drops the field silently", and the reply shows it) and seven CLI tests pin how a newer CLI behaves against an older server (it keeps working, or says to restart it), so that is a policy call. |
| 2 | An approved script line stays approved after the agent rewrites it | Any section whose line the agent changes now goes back to draft (`src/core/script.ts`). This reverses what the doc comment said ("keeps ... status"), so it is its own commit: revert it if approval should survive a rewrite. |
| 3 | `~/...` in `project` makes a folder called `~` | A leading `~` or `~/` now means the home folder (`src/mcp/stdio.ts`). Not done: refusing a project folder that doesn't exist. Creating one on open may be wanted, so that is a policy call. |
| 4 | Two grabs of one frame at once: the second is a 500 | The temp file name carries `randomUUID()`, as the export routes already did (`src/server/app.ts`). |
| 11 | `docs/plans/` is 21,423 lines of finished plans | Removed. They are in git history, e.g. `git show 99857a9:docs/plans/2026-10-07-rushes-plan-8-sfx-layers.md`. |

## Open: should fix

5. **`rushes setup` overwrites a hand-fixed registration, and can make Codex's TOML invalid.** `src/setup/harnesses.ts:91-92,99,112-121`, `setup.ts:94-98`, `src/cli/doctor.ts:213-219`. Any `rushes` entry that isn't the exact default is replaced in JSON and TOML configs, so a full `npx` path with an `env` PATH (a common Claude Desktop fix with nvm) is lost, and `doctor` then suggests `rushes setup`, which undoes it. An inline `rushes = { ... }` under `[mcp_servers]` gets a second `[mcp_servers.rushes]` appended, which is invalid TOML. The Claude Code branch (`setup.ts:78`) already leaves a non-legacy entry alone. Fix: rewrite only an entry that names a legacy source; fail with "edit by hand" on an inline definition.
6. **CLI flags ignored or unchecked.** `src/cli/main.ts:217,224,276,284`. `--dir` is read at 217, but `open`, `serve` and `init` use `rest[0] ?? "."`. `--only curser` prints "No supported agent harness found" and exits 0. `--port abc` fails with "No free port from NaN" after creating `.rushes`. Fix: `rest[0] ?? o.dir ?? "."`; validate `--only` and `--port`; exit 2.
7. **Send to agent stamps the notes before it records the batch.** `src/server/app.ts:1175` then `:1182`. If the second write fails, notes point at a batch that doesn't exist: the tab says "1 to do", Send answers 409, and the next batch reuses `b_1`. Fix: build the batch from a snapshot first, then stamp the notes.
8. **Section ids are reused after a replace.** `src/core/script.ts:92-99`. A new section gets `s<position>`, skipping only ids still present, so a deleted `s2` is reissued and `picks.json` still maps `s2` to the old take. Fix: never-reused ids, or a counter in `script.json`.
9. **Note ids can repeat.** `src/core/notes.ts:30`, `ids.ts:4-6`. 24 random bits is about a 3% chance of a repeat by 1,000 notes, and a reply then lands on the other note. `log.ts:50-55` already redraws on a repeat. Fix: the same, two lines.
10. **Small helpers written two to four times, and the MCP tools hand-copy limits.** `fmt` exists four times (`web/src/lib.ts`, `src/cli/main.ts:596-602`, `src/core/exportNotes.ts:30-38`, `src/server/assets.ts:52-55`), with `shotAt`, `markLabel`, `LEVEL_*`, `OPEN_SAFE_EXT`, `VIDEO_EXT`, `fit` and `isChanged` copied between `src` and `web`. `src/mcp/tools.ts:20-21,32-38` repeats `StageSchema`, `FileKindSchema`, `FORMATS_BESIDE_CUT_MAX = 7` and a 1024-character path cap. The comment at `exportNotes.ts:32` says "src/ and web/ are separate TypeScript projects", but `web/src/versions.ts`, `changelog.ts` and `lib.ts:1330` already import from `src/core`. Pin tests exist only to keep the copies equal. Fix: move them into import-free modules like `labels.ts`, `logText.ts` and `formats.ts` (guarded by `test/helpers/imports.ts`). About 88 lines, plus the pin tests.
12. **Test setup is copy-pasted 13 times** (about 216 lines): the HTTP `call/post/put` helper in eight server test files, the CLI `io()` in three, the MCP `connect()` in three. Fix: `test/helpers/{app,cli,mcp}.ts`, about 60 lines saved.
13. **`src/server/reveal.ts:38-79` is never run in tests.** It runs `open -R`, `explorer.exe /select,` or `xdg-open`, and `vitest.config.ts:8` sets `RUSHES_NO_REVEAL=1` for every test. CI has no Windows job. Fix: one table test mocking `node:child_process`, about 25 lines.
14. **Code with no caller:** `Store.backup` (`src/core/store.ts:136-140`), `findVideo` (`project.ts:200-204`), the `renderMarkdown` alias (`web/src/markdown.ts:197-199`), `firstPositional` (`main.ts:152-156`), `BUILT` (`web/src/lib.ts:83-84`) and `isTakeStale` (`script.ts:21-24`). About 33 lines, plus 7 test lines that only touch them.

## Open: nice to have

15. **Any website can make Rushes run ffmpeg.** The Origin and JSON guard covers writes only, so a cross-site `<img src=".../frame?t=N">` starts one ffmpeg per `t` with no cap on how many run at once. It needs a guessed film name and leaks no data. Fix: refuse `sec-fetch-site: cross-site` unless `sec-fetch-mode` is `navigate`, about three lines. `src/server/app.ts:395-415,1014-1037`.
16. `/api/state` reads and sends all of `batches.json` on every refresh, and nothing reads it (`app.ts:675,686`, `web/src/types.ts:33`).
17. Keyboard-shortcut handling and the "is the user typing" check are copied across `Picture.tsx`, `AudioStage.tsx` and `App.tsx`; one helper in `lib.ts`.
18. The same behaviour is tested at unit and e2e level: `e2e/changelog.spec.ts:124-130` and `test/server/log.test.ts:76-85`; the contrast check in `test/web/styles.test.ts:40-52` and `e2e/formats.spec.ts:541-566`.
19. The version is written in `package.json`, the lockfile, `.claude-plugin/plugin.json`, `src/server/app.ts:36` and `test/package.test.ts`, plus a literal "0.4.0" test. Read `VERSION` from `package.json`.
20. 206 KB of the 676 KB in `web-dist` is `.woff` duplicating `.woff2`; `@fontsource-variable/*` ships woff2 only. Package size only.
21. The Claude Code plugin's `.mcp.json` launches bare `npx`, which the README says harnesses can't start on Windows. Add a note. Not run on Windows.

## Checked and healthy

Every write goes through one server, with a queue per file, a whole-file schema check and an atomic write. The Host, Origin and JSON guard covers every route, `/assets/*` and `/media` included. Media serving blocks traversal, checks symlinks, supports byte ranges, and sends risky types as downloads with a sandbox header. SSE listeners are removed when a client disconnects. A stalled read of a 512 MB file added 9 MB of memory. `ffprobe` and `ffmpeg` run with argument arrays, a protocol whitelist and timeouts. The web bundle is 181 KB of JavaScript (61 KB gzipped), Preact only. Audio contexts are closed when a tab is left and every cache has a cap. Controls are labelled and work from the keyboard. Every dependency is used.

Size at 99857a9: `src` 11,259 lines, `web` 11,365, `test` 19,842, `e2e` 7,940, `docs` 23,314 (of which 21,423 were `docs/plans`).

## Not checked

No test suite was run by the audit (main CI was green). Nothing was run in a browser: Picture re-renders its whole view every frame while playing, and Assets video tiles keep their players once scrolled into view; neither was measured. The scoring in `found.ts` and `loudness.ts` was only skimmed. Windows paths were not run. The audit is thorough, not exhaustive: findings 2, 7 and 8 were not reported by the three agents that read this code. They came from a separate pass over an older copy of the repo and were then confirmed present in 99857a9.
