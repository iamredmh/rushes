// §27, 5.2: the top bar, one line of 44 px. Left to right: the logo and the project's name, the Film menu, the Cut menu;
// the workspaces centred; at the right, the agent's chip while it has a run (§28), the notes panel's toggle and More.
// Nothing else (Share waits for review links).
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";

/** The Cut menu's narrowest: its "Cut" label, id and chevron, with no room for its label. */
const CUT_MIN = 96;
const cutShort = (el: Element | null) => (el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0);

/**
 * The left part's names (the project's, the film's) show whole while they fit: the Cut menu's label gives way first. Only
 * when they would not fit with the Cut menu at its narrowest is the part "tight", and then every name shrinks with it.
 * A flex weight alone would take a fraction of a pixel from each name whenever anything overflowed, and cut it short.
 */
function useTight(left: RefObject<HTMLDivElement>, bar: RefObject<HTMLElement>) {
  const fit = () => {
    const el = left.current;
    const cut = el?.querySelector<HTMLElement>(".vwrap");
    if (!el || !el.lastElementChild) return;
    const box = el.getBoundingClientRect();
    const used = el.lastElementChild.getBoundingClientRect().right - box.left;
    // What the names need whole, with the Cut menu at its narrowest.
    const need = used - (cut ? cut.getBoundingClientRect().width - CUT_MIN : 0) + cutShort(el.querySelector(".pname")) + cutShort(el.querySelector(".filmname"));
    el.classList.toggle("tight", need > el.clientWidth + 0.5);
  };
  useLayoutEffect(fit);
  useEffect(() => {
    const ro = new ResizeObserver(() => fit());
    if (bar.current) ro.observe(bar.current);
    void document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, []);
}

export interface TopBarProps {
  barRef: RefObject<HTMLElement>;
  project: string;
  /** The project's id, as in its address. */
  projectId: string | null;
  film: ComponentChildren;
  cut: ComponentChildren;
  workspaces: ComponentChildren;
  /** §28: the agent's chip (AgentChip), before the notes toggle. */
  agent?: ComponentChildren;
  /** §27, 5.7: hides and shows the notes panel, in the workspaces that have one. */
  notesToggle?: ComponentChildren;
  more: ComponentChildren;
}

export function TopBar({ barRef, project, projectId, film, cut, workspaces, agent, notesToggle, more }: TopBarProps) {
  const left = useRef<HTMLDivElement>(null);
  useTight(left, barRef);
  return (
    <header class="top" ref={barRef}>
      <div class="tleft" ref={left}>
        <span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></span>
        <span class="proj" data-tip={projectId ? `${project} · ${projectId}` : project}>
          <span class="pname">{project}</span>
          {projectId && <span class="pid vh"> {projectId}</span>}
        </span>
        {film}
        {cut}
      </div>
      {workspaces}
      <div class="tright">{agent}{notesToggle}{more}</div>
    </header>
  );
}
