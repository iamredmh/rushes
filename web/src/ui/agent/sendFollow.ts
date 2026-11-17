// §28: what the desk does after Send (App.send), by what the server answered: the toast, and the browser's leave to
// notify, asked for once, the first time Send hands notes to an agent (plan 2, decision 5). The choice is followSend's.
import { followSend, type SendFollow } from "../../agent.js";
import type { AgentStatus, SendHandOver } from "../../types.js";

let notifyAsked = false;

/** Asks for browser notifications once per page, and only while the browser hasn't been answered yet. */
export function askNotificationsOnce(): void {
  if (notifyAsked) return;
  notifyAsked = true;
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    // An older Safari answers through a callback and returns nothing.
    void Promise.resolve(Notification.requestPermission()).catch(() => undefined);
  } catch {
    // No notifications here: the chip and the notes panel still say what needs you.
  }
}

/** Says what became of a Send (a toast, or nothing) and gives the rest of followSend's answer to the desk. */
export function actOnSend(r: SendHandOver | undefined, s: AgentStatus | null, toast: (message: string, ms?: number) => void): SendFollow {
  const f = followSend(r, s);
  if (f.toast) toast(f.toast.text, f.toast.ms);
  if (f.handed) askNotificationsOnce();
  return f;
}
