// §27, 5.2: the top bar, one line of 44 px. Left to right: the logo and the project's name, the Film menu, the Cut menu;
// the workspaces centred; More at the right. Nothing else (Share waits for review links).
import type { ComponentChildren, RefObject } from "preact";

export interface TopBarProps {
  barRef: RefObject<HTMLElement>;
  project: string;
  /** The project's id, as in its address. */
  projectId: string | null;
  film: ComponentChildren;
  cut: ComponentChildren;
  workspaces: ComponentChildren;
  more: ComponentChildren;
}

export function TopBar({ barRef, project, projectId, film, cut, workspaces, more }: TopBarProps) {
  return (
    <header class="top" ref={barRef}>
      <div class="tleft">
        <span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></span>
        <span class="proj" data-tip={projectId ? `${project} · ${projectId}` : project}>
          <span class="pname">{project}</span>
          {projectId && <span class="pid vh"> {projectId}</span>}
        </span>
        {film}
        {cut}
      </div>
      {workspaces}
      <div class="tright">{more}</div>
    </header>
  );
}
