// Spec §5.4: when the agent waits on the user (an ask, or a run that ends in a question) and no desk is open,
// Rushes says so with a notification (macOS, and since §34 Linux and Windows). Fixed text only: never a command or anything the agent wrote.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { findOnPath, windowsSystemTool } from "./spawn.js";
import { win32 } from "node:path";
import type { Store } from "../../core/store.js";
import { AGENT_NAMES, type AgentStatus } from "./runner.js";

/** Shows one notification. Never rejects in a way the caller must handle: a failure is only logged. */
export type Notifier = (title: string, body: string) => Promise<void>;

/** One line of AppleScript text: backslashes and quotes escaped, line breaks as spaces. */
const quoted = (s: string) => `"${s.replace(/[\r\n\t]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The AppleScript that shows `body` under `title`. */
export function notificationScript(title: string, body: string): string {
  return `display notification ${quoted(body)} with title ${quoted(title)}`;
}

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true, ...(env ? { env } : {}) }, (e) => (e ? reject(e) : resolve()));
  });

/**
 * §34: a Windows toast through PowerShell. The title and body are read from environment variables, never written into
 * the script, so no text can become code. Uses PowerShell's own app id, which every Windows 10 and 11 has registered.
 */
export const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null",
  "$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$t=$x.GetElementsByTagName('text')",
  "$t.Item(0).AppendChild($x.CreateTextNode($env:RUSHES_NOTIFY_TITLE))|Out-Null",
  "$t.Item(1).AppendChild($x.CreateTextNode($env:RUSHES_NOTIFY_BODY))|Out-Null",
  "$id='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join(";");

/**
 * The default: osascript on macOS, `notify-send` on Linux when it is installed, a PowerShell toast on Windows (§34).
 * Anything else, or a failure, shows nothing (a failure is logged). RUSHES_NO_NOTIFY=1 turns it off (the test suite
 * sets it, so no test shows a real notification).
 */
export function osNotifier(
  o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<void>; find?: (bin: string) => string | null } = {},
): Notifier {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exec = o.run ?? run;
  const find = o.find ?? ((bin: string) => findOnPath(bin));
  return async (title, body) => {
    if (env.RUSHES_NO_NOTIFY === "1") return;
    const line = (s: string) => s.replace(/[\r\n\t]+/g, " ");
    try {
      if (platform === "darwin") {
        await exec("osascript", ["-e", notificationScript(title, body)]);
      } else if (platform === "win32") {
        await exec(windowsSystemTool(win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_TOAST_SCRIPT], {
          ...process.env, RUSHES_NOTIFY_TITLE: line(title), RUSHES_NOTIFY_BODY: line(body),
        });
      } else {
        const bin = find("notify-send");
        if (!bin) return;
        // `--` ends the options, so a title can never be read as one.
        await exec(bin, ["--app-name=Rushes", "--", line(title), line(body)]);
      }
    } catch (e) {
      console.error(`Rushes: couldn't show a notification: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/**
 * Listens to the runner's status on `store` and calls `notify` when a new permission ask arrives, only while `watchers()` is 0 (no desk has the events stream open). Returns the function that stops listening.
 */
export function notifyWhenWaiting(store: Store, notify: Notifier, watchers: () => number): () => void {
  const seen = new Set<string>();
  // §35: a permission ask only. There is no question phase: the agent never asks the user anything on a note.
  const onStatus = (s: AgentStatus) => {
    const fresh = s.asks.some((a) => !seen.has(a.id));
    for (const a of s.asks) seen.add(a.id);
    if (!fresh || watchers() > 0) return;
    const name = s.agent ? AGENT_NAMES[s.agent] : "Your agent";
    void notify("Rushes", `${name} is waiting for you in ${basename(store.root)}`).catch(() => undefined);
  };
  store.on("agent", onStatus);
  return () => store.off("agent", onStatus);
}
