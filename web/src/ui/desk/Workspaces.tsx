// §27, 5.3: the workspaces, centred in the top bar. Plan (opening the Plan page last used; the pages have their own switch
// in the work area), Review, Visuals once the project has visuals, and Assets with the count of files found when there is one.
import type { ComponentChildren } from "preact";
import type { Workspace } from "../../desk.js";
import { LOCKED_TAB } from "../../lib.js";
import { Icon } from "../Icon.js";

export interface PlanWorkspace {
  /** Brief, script and storyboard all approved: the tab carries a tick. */
  approved: boolean;
  /** Plan edits not sent yet: the tab carries a dot. */
  open: number;
  /** No Plan page has anything in it yet. */
  locked: boolean;
}

export interface WorkspacesProps {
  current: Workspace;
  plan: PlanWorkspace;
  hasVisuals: boolean;
  assetsUnlocked: boolean;
  /** Files found and not looked at yet, shown on Assets; null for none. */
  found: { count: number; text: string } | null;
  onPick(workspace: Workspace): void;
}

export function Workspaces({ current, plan, hasVisuals, assetsUnlocked, found, onPick }: WorkspacesProps) {
  const tab = (ws: Workspace, icon: string, name: string, extra?: ComponentChildren, locked = false) => (
    <button
      type="button"
      class="tab"
      role="tab"
      aria-selected={current === ws}
      data-locked={locked ? "true" : undefined}
      data-tip={locked && ws === "assets" ? `Locked: ask your agent for ${LOCKED_TAB.assets.ask}` : undefined}
      onClick={() => onPick(ws)}
    >
      <Icon name={icon} />
      {name}
      {extra}
    </button>
  );
  return (
    <nav class="ws" role="tablist" aria-label="Workspaces">
      {tab(
        "plan",
        "list",
        "Plan",
        plan.locked ? (
          <>
            <Icon name="lock" class="lk" />
            <span class="vh"> Locked</span>
          </>
        ) : (
          <>
            {plan.approved && (
              <>
                <Icon name="check" class="pready" />
                <span class="vh"> Approved</span>
              </>
            )}
            {plan.open > 0 && <span class="dot" title={`${plan.open} not sent`} />}
          </>
        ),
        plan.locked,
      )}
      {tab("review", "film", "Review")}
      {hasVisuals && tab("visuals", "image", "Visuals")}
      {tab(
        "assets",
        "grid",
        "Assets",
        assetsUnlocked ? (
          found && (
            <>
              {" "}
              <span class="wcount" title={found.text}>{found.count}</span>
            </>
          )
        ) : (
          <>
            <Icon name="lock" class="lk" />
            <span class="vh"> Locked</span>
          </>
        ),
        !assetsUnlocked,
      )}
    </nav>
  );
}
