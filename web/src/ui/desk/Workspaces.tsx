// §27, 5.3: the workspaces, centred in the top bar. Plan (its pages in a menu until the Plan pages are rebuilt), Review,
// Visuals once the project has visuals, and Assets with the count of files found when there is one.
import type { ComponentChildren } from "preact";
import type { Workspace } from "../../desk.js";
import { LOCKED_TAB } from "../../lib.js";
import { Icon } from "../Icon.js";
import { PlanningTab, type PlanningTabProps } from "../Planning.js";

export interface WorkspacesProps {
  current: Workspace;
  plan: PlanningTabProps;
  hasVisuals: boolean;
  assetsUnlocked: boolean;
  /** Files found and not looked at yet, shown on Assets; null for none. */
  found: { count: number; text: string } | null;
  onPick(workspace: Exclude<Workspace, "plan">): void;
}

export function Workspaces({ current, plan, hasVisuals, assetsUnlocked, found, onPick }: WorkspacesProps) {
  const tab = (ws: "review" | "visuals" | "assets", icon: string, name: string, extra?: ComponentChildren, locked = false) => (
    <button
      type="button"
      class="tab"
      role="tab"
      aria-selected={current === ws}
      data-locked={locked ? "true" : undefined}
      data-tip={locked ? `Locked: ask your agent for ${LOCKED_TAB.assets.ask}` : undefined}
      onClick={() => onPick(ws)}
    >
      <Icon name={icon} />
      {name}
      {extra}
    </button>
  );
  return (
    <nav class="ws" role="tablist" aria-label="Workspaces">
      <PlanningTab {...plan} />
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
