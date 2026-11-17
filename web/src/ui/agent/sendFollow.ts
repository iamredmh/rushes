// §28: what the desk does after Send (App.send), by what the server answered (the choice is followSend's), and the
// browser's leave to notify, asked for once, in the press that first sends notes to an agent (plan 2, decision 5).
import { followSend, type SendFollow } from "../../agent.js";
import type { AgentStatus, SendHandOver } from "../../types.js";

let notifyAsked = false;

/**
 * Asks for browser notifications once per page, and only while the browser hasn't been answered yet. Call it in the
 * click or key handler itself, before any await: Safari and Firefox ignore a request made outside a user's gesture.
 */
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

/**
 * Says what became of a Send (a toast, or nothing) and gives the rest of followSend's answer to the desk. Notifications
 * are not asked for here: this runs after Send's request, when the click's gesture has gone (Send and the sheet's
 * Send to <A> ask in the press itself).
 */
export function actOnSend(r: SendHandOver | undefined, s: AgentStatus | null, toast: (message: string, ms?: number) => void): SendFollow {
  const f = followSend(r, s);
  if (f.toast) toast(f.toast.text, f.toast.ms);
  return f;
}
