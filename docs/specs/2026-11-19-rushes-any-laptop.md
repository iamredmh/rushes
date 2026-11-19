# §34 Send to AI on any laptop

## 34.1 The problem

Red (19 Nov 2026): "It's important that they don't have to have any special circumstances other than they just have a laptop, irrespective whether it's a Mac, a PC, etc. … so long as they've got a Claude instance or ChatGPT, Codex … download Rushes or install it and then use the Send to AI feature without any kind of extra things." No iCloud or other cloud service may be needed. Rushes needs none today, and that stays true.

An audit of 0.12.0 (19 Nov) found that Send to AI couldn't work on native Windows: detection ran `which`, the status check and the adapter were started without a shell, so `claude.cmd`, `codex.cmd` and `npx` failed. The Always rules didn't know Windows shells (`cmd /c`, `powershell -Command`, `start`, `wsl`) or Windows path tricks (8.3 short names, trailing dots, `::$DATA` streams). On every OS the first Send ran `npx -y` on the adapter package. That pulls in a bundled native agent of about 350 MB, inside the 2-minute start timeout, so it failed offline, behind a proxy or on a slow link. Sign-in help and notifications worked only on a Mac. A missing agent got no install help.

## 34.2 Decisions

### Finding and starting agents (`src/server/agent/spawn.ts`)
- `findOnPath(bin)` searches PATH, and PATHEXT on Windows, in Node. `which` is no longer used.
- Detection, the status and version checks, and the adapter all run the resolved path through `cross-spawn`, which wraps `.cmd`/`.bat` in `cmd.exe /d /s /c` and quotes the arguments correctly. Nothing runs through a shell on macOS or Linux, the same as before.
- The search path adds, after the user's PATH, the folder of the Node that runs Rushes, `$NVM_BIN`, `~/.volta/bin`, `~/.npm-global/bin`, `~/.bun/bin` and `npm prefix -g`'s bin folder (`%APPDATA%\npm` on Windows), then Homebrew, `/usr/local/bin` and `~/.local/bin` as before.

### No download at Send time (`src/server/agent/connectors.ts`)
- **Chosen: fetch the adapters once, ahead of time, into the user's cache folder. They are not dependencies of Rushes.** As dependencies, `npx -y rushes` would bring both adapters and both bundled native agents (about 700 MB together, from `npm view`) to everyone, including people who only use the MCP server, on every first run. Ahead of time, Rushes installs each adapter with `--omit=optional`, which leaves out the bundled agent. The adapters then use the CLI the user already has (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`, as before). That's about 77 MB for Claude's and 21 MB for Codex's (measured 19 Nov on the Mac mini, macOS arm64), fetched once per adapter version.
- Checked 19 Nov on the Mac mini: both adapters, installed this way, start, open a session and answer a prompt with the user's own `claude` and `codex`.
- **When:** for each installed agent, the desk server starts the fetch in the background as soon as it starts, and `rushes setup` fetches with a line per adapter. The desk shows "Getting Claude Code ready…" with a spinner in the first-Send sheet and the agent menu until it's done. A Send made meanwhile waits for that fetch. The fetch doesn't count against the 2-minute start timeout, and it is never started again just for the Send.
- **Where:** `$XDG_CACHE_HOME/rushes` when set (absolute), else `~/Library/Caches/rushes` on a Mac, `%LOCALAPPDATA%\rushes\Cache` on Windows, `~/.cache/rushes` on Linux. Each adapter version goes in its own folder, `connectors/<agent>-<version>/`, written to a temporary folder and renamed into place, so a half-finished fetch is never used.
- **How:** with the npm that came with the Node running Rushes (`npm-cli.js` beside `process.execPath`, else `npm` on the search path), run from the cache folder, never from a project. A project's own `.npmrc` can't redirect the download. The user's own npm settings (proxy, registry) still apply.
- **Start:** the adapter runs as `node <entry>` with the same Node as Rushes, from the cache folder. There's no npx at run time.
- The README no longer calls it a small adapter.

### Windows safety rules (`src/core/agentRules.ts`, `broker.ts`)
Every change only makes the rules stricter. No POSIX rule is weakened.
- **Shell and wrapper lists:** SHELLS adds `cmd`, `powershell`, `pwsh`, `wsl`, `bash`, `cscript`, `wscript`, `mshta` and `nu`. WRAPPERS adds `start`, `rundll32`, `forfiles`, `runas`, `psexec`, `conhost`, `schtasks`, `at` and `explorer`. On every OS, a name is matched with `.exe`, `.cmd`, `.bat` or `.com` stripped. A name on these lists never gets an Always rule.
- **Flags:** on Windows a word starting with `/` is a flag, so it never becomes part of an Always rule.
- **Unwrapping:** the broker unwraps `cmd /c <script>` (and `/d /s /c`, `/k`), and `powershell` or `pwsh` with `-Command`, `-c` or `/c`, the same way it already unwraps `bash -lc`. An Always rule then names the real command.
- **SAFE_COMMAND:** on Windows `%` is dropped, because cmd expands it. A backslash is still refused on every OS, so a Windows path in a command never gets Always.
- **Paths:** `realpathSync.native`; on Windows the inside-the-project check and protected names compare case-insensitively.
- **Ask instead:** on Windows a path with a part that ends in a dot or a space, holds `:` (a stream), or looks like an 8.3 short name (`~1`) isn't treated as in the project. It asks.

### Sign-in on every OS (`terminal.ts`)
- Mac: Terminal, as before, now running the detected path.
- Windows: a new Command Prompt window running a short `.cmd` file with the detected path and `auth login` (or `login`).
- Linux: the first terminal found of `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal` and `xterm`. When there's none, the desk shows the command with a Copy button.
- The button reads "Sign in in Terminal" on a Mac, "Sign in in Command Prompt" on Windows and "Sign in in a terminal" on Linux. The server's error text uses the same words.

### Versions and Node
- Detection reads `--version`. Below the tested minimum (Claude Code 2.0.0, Codex 0.163.0, the oldest seen working with these adapters on 19 Nov), the agent shows "Update Claude Code" or "Update Codex" with the command, and Send refuses it as it refuses a signed-out agent.
- `engines.node` is now `>=22.12.0`, because the Claude adapter declares `node >=22`. `rushes doctor` checks the same, and CI runs Node 22.12 and 22.
- **Mac and Linux users on Node 20 must update Node.** This is the one change existing users see.

### Help when something is missing
- An agent that isn't installed shows its install command (`npm install -g @anthropic-ai/claude-code`, `npm install -g @openai/codex`) with a Copy button and a link to its own setup page.
- `rushes doctor` (and `rushes_doctor`) checks each agent CLI: installed, its version, signed in, and whether its adapter is ready.
- Notifications: `notify-send` on Linux when present, a PowerShell toast on Windows, osascript on a Mac as before. The text is passed in environment variables, never put into a script. A failure is silent.

### Stop, config folder, CI
- Stop kills the whole adapter process tree: `taskkill /T /F` on Windows, and on macOS and Linux the adapter runs in its own process group, which gets SIGTERM, then SIGKILL after 2 s.
- **Windows config folder:** `%APPDATA%\rushes`. A rules or default file that's only in the old `%USERPROFILE%\.config\rushes` is still read, and the next write goes to the new place. A rename that fails with EPERM, EBUSY or EACCES (antivirus, indexer) is retried. Nothing changes on a Mac or Linux.
- **CI** adds a `windows-latest` job (Node 22): typecheck, unit tests, and the agent browser suite in Chromium. A smoke test puts a fake `claude`/`codex` (a `.cmd` on Windows) on PATH and checks detection, the version and status checks, spawn and an ACP handshake. `path.win32` cases cover the attacks above, and each one must ask.

## 34.3 Not changed
The token in `~/.config/rushes/claude-token`, `rushes-desk`, any project's stored rules, the Mac default, every POSIX safety rule, and the no-cloud rule all stay as they were.

## 34.4 Not verified on real Windows hardware
CI covers detection, quoting, the rules and the browser suite. A real-PC check should cover:
- Claude Code (npm `.cmd` and the native `claude.exe`) and Codex: install, sign in through the button, a first Send in each permission row, and Stop leaving no `node.exe` behind.
- The toast.
- Auto mode: Claude's `auto` and Codex's `agent`, and whether Codex's read-only sandbox works on Windows.
