// §28, 5.1: the first-Send sheet. The first Send in a project asks who should get the notes before anything is posted;
// "Set up Send to AI" in the panel's foot, and Set up in the copy dialog, open it too. Two small steps, each a question
// (ruling P2-R3): who gets the notes (an agent, or copying a prompt as now, which skips step 2), then what that agent may
// do without asking. Confirming posts setup, then the desk's own Send runs when notes are waiting.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { MENU_WORDS, PERMISSION_CHOICES, SHEET_WORDS, mayQuestion, notSignedInWhy, sheetDefault, sheetPrimary, sheetRows, whoNext, type Sheet, type SheetPick } from "../../agent.js";
import { api, ApiError } from "../../api.js";
import type { AgentId, AgentInfo, AgentRules, AgentStatus } from "../../types.js";

export interface FirstSendProps {
  status: AgentStatus;
  /** Notes wait to be sent: confirming sends them once Send to AI is set up. */
  waiting: boolean;
  /** A status the setup route just answered with. */
  onStatus(status: AgentStatus): void;
  toast(message: string): void;
  /** The sheet goes; `done` when it was answered (setup posted), not cancelled. */
  onClose(done: boolean): void;
  /** Runs the desk's Send with the status setup answered. */
  onSend(status: AgentStatus): void;
}

/** The server refusing an agent that isn't signed in or installed now (409). */
const isRefusal = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409 && (e.code === "agent_not_signed_in" || e.code === "agent_not_installed");

const detect = (fresh: boolean): Promise<AgentInfo[]> =>
  api.get<{ agents: AgentInfo[] }>(`/api/agent/detect${fresh ? "?fresh=1" : ""}`).then((r) => r.agents, () => []);

export function FirstSend({ status, waiting, onStatus, toast, onClose, onSend }: FirstSendProps) {
  const [detected, setDetected] = useState<AgentInfo[] | null>(null);
  // Step 1 once detection answers (the rows to pick from are known then).
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [refused, setRefused] = useState<{ agent: AgentId; message: string } | null>(null);
  // One setup at a time: a second press while one is on its way does nothing.
  const busy = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  // Focus goes back where it was (Send, the row, Set up) when the sheet goes.
  const opener = useRef<Element | null>(document.activeElement);
  const rows = sheetRows(detected);

  const close = (done: boolean) => {
    onClose(done);
    const back = opener.current;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };
  const latestClose = useRef(close);
  latestClose.current = close;

  useLayoutEffect(() => {
    void detect(false).then((agents) => {
      setDetected(agents);
      setSheet({ step: "who", pick: sheetDefault(sheetRows(agents), status.agent) });
    });
    // Escape closes the sheet wherever focus is, and only the sheet (App's own Escape would close the dialog under it).
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      latestClose.current(false);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);

  // Each step opens with focus on its picked row.
  const step = sheet?.step;
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
  }, [step]);

  /** Posts setup; a refusal for an agent goes back to step 1 and says why under its row. */
  const setup = async (body: { on: boolean; agent?: AgentId; permissions?: AgentRules["permissions"] }): Promise<AgentStatus | null> => {
    try {
      const s = (await api.post<{ status: AgentStatus }>("/api/agent/setup", body)).status;
      onStatus(s);
      return s;
    } catch (e) {
      if (isRefusal(e) && body.agent) {
        setSheet({ step: "who", pick: body.agent });
        setRefused({ agent: body.agent, message: e.message });
      } else toast((e as Error).message);
      return null;
    }
  };
  const finish = (s: AgentStatus | null) => {
    if (!s) return;
    close(true);
    if (waiting) onSend(s);
  };
  const may = (agent: AgentId): Sheet => ({ step: "may", agent, permissions: status.permissions });

  const confirm = async () => {
    if (!sheet || busy.current) return;
    busy.current = true;
    try {
      if (sheet.step === "may") return finish(await setup({ on: true, agent: sheet.agent, permissions: sheet.permissions }));
      setRefused(null);
      const next = whoNext(sheet.pick, rows);
      if (next === "copy") return finish(await setup({ on: false }));
      if (next === "missing") return;
      const agent = sheet.pick as AgentId;
      if (next === "may") return setSheet(may(agent));
      // Not signed in when the sheet opened: checked again now, for someone who has just signed in in Terminal.
      const fresh = await detect(true);
      setDetected(fresh);
      if (whoNext(agent, sheetRows(fresh)) === "may") return setSheet(may(agent));
      setRefused({ agent, message: notSignedInWhy(agent) });
    } finally {
      busy.current = false;
    }
  };
  const pick = (p: SheetPick) => {
    setRefused(null);
    setSheet({ step: "who", pick: p });
  };
  const signIn = (agent: AgentId) => void api.post("/api/agent/sign-in", { agent }).catch((e: Error) => toast(e.message));
  // Enter on a row goes on, as the button does (a radio has no Enter of its own).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type === "radio") {
      e.preventDefault();
      void confirm();
    }
  };

  return (
    <div class="pop firstsend" role="dialog" aria-labelledby="fs-title" ref={box} onKeyDown={onKeyDown}>
      <h3 id="fs-title">{sheet?.step === "may" ? mayQuestion(sheet.agent) : SHEET_WORDS.who}</h3>
      {sheet?.step === "who" && (
        <div class="fsopts" role="radiogroup" aria-labelledby="fs-title">
          {rows.map((r) => (
            <div class="fsrow" key={r.pick}>
              <label class={`fsopt${sheet.pick === r.pick ? " on" : ""}${r.state === "missing" ? " off" : ""}${r.state === "signedOut" ? " signin" : ""}`}>
                <input type="radio" name="fs-who" value={r.pick} checked={sheet.pick === r.pick} disabled={r.state === "missing"} onChange={() => pick(r.pick)} />
                <span class="fstext">
                  <b>{r.name}</b>
                  {r.note && <small class={r.state === "signedOut" ? "todo" : undefined}>{r.note}</small>}
                </span>
              </label>
              {r.state === "signedOut" && (
                <button type="button" class="btn ghost fssign" onClick={() => signIn(r.pick as AgentId)}>
                  {MENU_WORDS.signIn}
                </button>
              )}
              {refused?.agent === r.pick && (
                <p class="fserr" role="alert">
                  {refused.message}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {sheet?.step === "may" && (
        <>
          <div class="fsopts" role="radiogroup" aria-labelledby="fs-title">
            {PERMISSION_CHOICES.map((p) => (
              <div class="fsrow" key={p.value}>
                <label class={`fsopt${sheet.permissions === p.value ? " on" : ""}`}>
                  <input type="radio" name="fs-may" value={p.value} checked={sheet.permissions === p.value} onChange={() => setSheet({ ...sheet, permissions: p.value })} />
                  <span class="fstext">
                    <b>{p.label}</b>
                  </span>
                </label>
              </div>
            ))}
          </div>
          <p class="fsline">{SHEET_WORDS.noKey}</p>
        </>
      )}
      {sheet && (
        <div class="fsacts">
          {sheet.step === "may" && (
            <button type="button" class="btn ghost" onClick={() => setSheet({ step: "who", pick: sheet.agent })}>
              {SHEET_WORDS.back}
            </button>
          )}
          <span class="sp" />
          <button type="button" class="btn ghost" onClick={() => close(false)}>
            {SHEET_WORDS.cancel}
          </button>
          <button type="button" class="btn primary" onClick={() => void confirm()}>
            {sheetPrimary(sheet)}
          </button>
        </div>
      )}
    </div>
  );
}

/** Above the copy dialog's prompt when Send to AI is on but nothing was started (not signed in, not installed): why, and Set up. */
export function WhyLine({ why, onSetUp }: { why: string; onSetUp(): void }) {
  return (
    <p class="swhy">
      <span>{why}</span>
      <button type="button" class="btn" onClick={onSetUp}>
        {SHEET_WORDS.setUp}
      </button>
    </p>
  );
}
