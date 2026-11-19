// §28, 5.1: the first-Send sheet. The first Send in a project asks who should get the notes before anything is posted;
// "Set up Send to AI" in the panel's foot, and Set up in the copy dialog, open it too. Two small steps, each a question
// (ruling P2-R3): who gets the notes (an agent, or copying a prompt as now, which skips step 2), then what that agent may
// do without asking. Confirming posts setup, then the desk's own Send runs when notes are waiting.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { HelpLine } from "./HelpLine.js";
import { BYPASS_WARNING, HELP_WORDS, PERMISSION_CHOICES, setDeskPlatform, signInWord, SHEET_WORDS, mayQuestion, notSignedInWhy, sheetDefault, sheetPrimary, sheetRows, whoNext, type SendFollow, type Sheet, type SheetPick } from "../../agent.js";
import { api, ApiError } from "../../api.js";
import type { AgentId, AgentInfo, AgentRules, AgentStatus, SendHandOver } from "../../types.js";
import { actOnSend, askNotificationsOnce } from "./sendFollow.js";

// The desk takes everything of Send to AI's first Send from here (one import in App).
export { actOnSend, askNotificationsOnce } from "./sendFollow.js";
export { planLead } from "../../agent.js";

/** What the setup route answers: the status, and, when it handed the dialog's batch over (I3), what became of it. */
interface SetupAnswer { status: AgentStatus; agent?: SendHandOver }

export interface FirstSendProps {
  status: AgentStatus;
  /** Notes wait to be sent: confirming sends them once Send to AI is set up. */
  waiting: boolean;
  /** I3: the filed batch the copy dialog showed when its Set up opened the sheet; setup hands it to the agent. */
  batch: string | null;
  /** A status the setup route just answered with. */
  onStatus(status: AgentStatus): void;
  toast(message: string): void;
  /** The sheet goes; `done` when it was answered (setup posted), not cancelled, with what setup answered. */
  onClose(done: boolean, answer?: SetupAnswer): void;
  /** Runs the desk's Send with the status setup answered. */
  onSend(status: AgentStatus): void;
}

/** The server refusing an agent that isn't signed in or installed now (409). */
const isRefusal = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409 && (e.code === "agent_not_signed_in" || e.code === "agent_not_installed" || e.code === "agent_outdated");

const detect = (fresh: boolean): Promise<AgentInfo[]> =>
  api.get<{ agents: AgentInfo[]; platform?: string }>(`/api/agent/detect${fresh ? "?fresh=1" : ""}`).then(
    (r) => {
      setDeskPlatform(r.platform);
      return r.agents;
    },
    () => [],
  );

export function FirstSend({ status, waiting, batch, onStatus, toast, onClose, onSend }: FirstSendProps) {
  const [detected, setDetected] = useState<AgentInfo[] | null>(null);
  // Step 1 once detection answers (the rows to pick from are known then).
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [refused, setRefused] = useState<{ agent: AgentId; message: string } | null>(null);
  // §34: the sign-in that couldn't open a terminal here: its command shows under the row, to copy.
  const [noTerminal, setNoTerminal] = useState<AgentId | null>(null);
  // One confirm at a time: while one is on its way the buttons are off and Escape waits (busy is read in handlers,
  // pending drawn). Once the sheet has closed, nothing a late answer brings sends (closed).
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const closed = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  // Focus goes back where it was (Send, the row, Set up) when the sheet goes.
  const opener = useRef<Element | null>(document.activeElement);
  const rows = sheetRows(detected);

  const close = (done: boolean, answer?: SetupAnswer) => {
    if (closed.current) return;
    closed.current = true;
    onClose(done, answer);
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
      // Send to <A> was pressed and its setup is on its way: the sheet finishes what it started.
      if (!busy.current) latestClose.current(false);
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
  const setup = async (body: { on: boolean; agent?: AgentId; permissions?: AgentRules["permissions"]; batch?: string; prompt?: boolean }): Promise<SetupAnswer | null> => {
    try {
      const answer = await api.post<SetupAnswer>("/api/agent/setup", body);
      onStatus(answer.status);
      return answer;
    } catch (e) {
      if (isRefusal(e) && body.agent) {
        setSheet({ step: "who", pick: body.agent });
        setRefused({ agent: body.agent, message: e.message });
      } else toast((e as Error).message);
      return null;
    }
  };
  const finish = (a: SetupAnswer | null) => {
    if (!a || closed.current) return;
    close(true, a);
    if (waiting) onSend(a.status);
  };
  // §33: Accept edits is pre-selected, unless the user already chose another row; Bypass is never pre-selected.
  const may = (agent: AgentId): Sheet => ({ step: "may", agent, permissions: status.asked && status.permissions !== "bypass" ? status.permissions : "project-edits" });

  const confirm = async () => {
    if (!sheet || busy.current) return;
    // Asked in the press itself, before anything is awaited: a browser only shows the request in a user's gesture.
    if (sheet.step === "may") askNotificationsOnce();
    busy.current = true;
    setPending(true);
    try {
      if (sheet.step === "may") return finish(await setup({ on: true, agent: sheet.agent, permissions: sheet.permissions, ...(batch ? { batch } : {}) }));
      setRefused(null);
      const next = whoNext(sheet.pick, rows);
      // §32: Copy a prompt is the answer for new projects on this Mac too.
      if (next === "copy") return finish(await setup({ on: false, prompt: true }));
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
      setPending(false);
    }
  };
  const pick = (p: SheetPick) => {
    setRefused(null);
    setSheet({ step: "who", pick: p });
  };
  const signIn = (agent: AgentId) =>
    void api.post("/api/agent/sign-in", { agent }).catch((e: Error) => {
      if (e instanceof ApiError && e.code === "no_terminal") setNoTerminal(agent);
      else toast(e.message);
    });
  // §34: while a connector downloads, the sheet looks again every 2 s, so "Getting ready…" clears when it's done.
  const fetching = (detected ?? []).some((a) => a.connector?.state === "fetching");
  useEffect(() => {
    if (!fetching) return;
    const t = setInterval(() => void detect(false).then(setDetected), 2000);
    return () => clearInterval(t);
  }, [fetching]);
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
              <label class={`fsopt${sheet.pick === r.pick ? " on" : ""}${r.state === "missing" || r.state === "outdated" ? " off" : ""}${r.state === "signedOut" ? " signin" : ""}`}>
                <input type="radio" name="fs-who" value={r.pick} checked={sheet.pick === r.pick} disabled={r.state === "missing" || r.state === "outdated"} onChange={() => pick(r.pick)} />
                <span class="fstext">
                  <b>{r.name}</b>
                  {r.note && <small class={r.state === "signedOut" || r.state === "outdated" ? "todo" : undefined}>{r.note}</small>}
                </span>
              </label>
              {r.state === "signedOut" && (
                <button type="button" class="btn ghost fssign" onClick={() => signIn(r.pick as AgentId)}>
                  {signInWord()}
                </button>
              )}
              {r.help && <HelpLine help={r.help} />}
              {r.state === "signedOut" && noTerminal === r.pick && (
                <HelpLine help={{ kind: "signIn", command: (detected ?? []).find((a) => a.id === r.pick)?.signIn ?? "" }} lead={HELP_WORDS.inTerminal} />
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
                  <input type="radio" name="fs-may" value={p.value} aria-label={p.label} aria-describedby={`fs-may-${p.value}`} checked={sheet.permissions === p.value} onChange={() => setSheet({ ...sheet, permissions: p.value })} />
                  <span class="fstext">
                    <b>{p.label}</b>
                    <small id={`fs-may-${p.value}`}>{p.hint}</small>
                  </span>
                </label>
              </div>
            ))}
          </div>
          {sheet.permissions === "bypass" && (
            <p class="fswarn" role="note">
              {BYPASS_WARNING}
            </p>
          )}
          <p class="fsline">{SHEET_WORDS.noKey}</p>
        </>
      )}
      {sheet && (
        <div class="fsacts">
          {sheet.step === "may" && (
            <button type="button" class="btn ghost" disabled={pending} onClick={() => setSheet({ step: "who", pick: sheet.agent })}>
              {SHEET_WORDS.back}
            </button>
          )}
          <span class="sp" />
          <button type="button" class="btn ghost" disabled={pending} onClick={() => close(false)}>
            {SHEET_WORDS.cancel}
          </button>
          <button type="button" class="btn primary" disabled={pending} onClick={() => void confirm()}>
            {sheetPrimary(sheet, waiting || batch !== null)}
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

/**
 * The desk's hold on the sheet: whether it is open, opening it (Send, Set up Send to AI, the dialog's Set up with its
 * batch), and the sheet itself for the desk to place. `onAnswered`: setup went through; with what became of the dialog's
 * batch when setup handed it over (a toast says so, as after Send), else null (the dialog drops its stale reason).
 */
export function useFirstSend(agent: AgentStatus | null, onStatus: (s: AgentStatus) => void, toast: (m: string, ms?: number) => void, onAnswered: (f: SendFollow | null) => void) {
  const [shown, setShown] = useState<{ batch: string | null } | null>(null);
  // A click handler may pass its event: only a batch id names a batch.
  const open = (batch?: unknown) => setShown({ batch: typeof batch === "string" ? batch : null });
  const sheet = (waiting: boolean, send: (status: AgentStatus) => void) =>
    shown && agent ? (
      <FirstSend
        status={agent}
        waiting={waiting}
        batch={shown.batch}
        onStatus={onStatus}
        toast={toast}
        onClose={(done, answer) => {
          setShown(null);
          if (done) onAnswered(answer?.agent ? actOnSend(answer.agent, answer.status, toast) : null);
        }}
        onSend={send}
      />
    ) : null;
  return { shown: shown !== null, open, sheet };
}
