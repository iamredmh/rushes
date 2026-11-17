// Spec §5.4: when the agent waits on the user (an ask, or a run that ends in a question) and no desk is open,
// Rushes says so with a macOS notification. Fixed text only: never a command or anything the agent wrote.
import { execFile } from "node:child_process";
import { basename } from "node:path";
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

const run = (file: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, args, { timeout: 10_000 }, (e) => (e ? reject(e) : resolve()));
  });

/**
 * The default: `osascript -e 'display notification …'` on macOS, nothing on other platforms. RUSHES_NO_NOTIFY=1
 * turns it off (the test suite sets it, so no test shows a real notification).
 */
export function osNotifier(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: (file: string, args: string[]) => Promise<void> } = {}): Notifier {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exec = o.run ?? run;
  return async (title, body) => {
    if (platform !== "darwin" || env.RUSHES_NO_NOTIFY === "1") return;
    try {
      await exec("osascript", ["-e", notificationScript(title, body)]);
    } catch (e) {
      console.error(`Rushes: couldn't show a notification: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/**
 * Listens to the runner's status on `store` and calls `notify` when a new ask arrives or the run reaches question,
 * only while `watchers()` is 0 (no desk has the events stream open). Returns the function that stops listening.
 */
export function notifyWhenWaiting(store: Store, notify: Notifier, watchers: () => number): () => void {
  const seen = new Set<string>();
  let phase: AgentStatus["phase"] | null = null;
  const onStatus = (s: AgentStatus) => {
    const fresh = s.asks.some((a) => !seen.has(a.id));
    for (const a of s.asks) seen.add(a.id);
    const question = s.phase === "question" && phase !== "question";
    phase = s.phase;
    if (!(fresh || question) || watchers() > 0) return;
    const name = s.agent ? AGENT_NAMES[s.agent] : "Your agent";
    void notify("Rushes", `${name} is waiting for you in ${basename(store.root)}`).catch(() => undefined);
  };
  store.on("agent", onStatus);
  return () => store.off("agent", onStatus);
}
