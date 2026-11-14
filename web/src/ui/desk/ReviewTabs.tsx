// §27, 5.4 to 5.6: Review's tabs. The timeline, then a tab per sound carrying its count of takes (a quiet number, or
// "N new" on the accent while takes wait to be chosen). The mix plays on the timeline, so it has no tab (5.6).
import type { DeskView } from "../../desk.js";
import { Icon } from "../Icon.js";

export interface ReviewTabRow {
  view: DeskView;
  label: string;
  icon: string;
  /** No takes (or no cut) yet: the tab opens its "nothing here yet" page. */
  locked: boolean;
  /** What a locked tab's tooltip asks your agent for. */
  ask: string;
  /** Takes on this film: all of them, and how many are new. Null for the timeline. */
  takes: { all: number; fresh: number } | null;
  /** Open notes on this tab. */
  todo: number;
}

export function ReviewTabs({ rows, selected, onPick }: { rows: ReviewTabRow[]; selected: DeskView; onPick(view: DeskView): void }) {
  return (
    <nav class="rtabs" role="tablist" aria-label="Review">
      {rows.map((r) => (
        <button
          key={r.view}
          type="button"
          class="tab"
          role="tab"
          aria-selected={selected === r.view}
          data-locked={r.locked ? "true" : undefined}
          data-tip={r.locked ? `Locked: ask your agent for ${r.ask}` : undefined}
          onClick={() => onPick(r.view)}
        >
          <Icon name={r.icon} />
          {r.label}
          {r.locked ? (
            <>
              <Icon name="lock" class="lk" />
              {/* Visually hidden, not aria-hidden: an enabled, clickable tab is announced as locked. */}
              <span class="vh"> Locked</span>
            </>
          ) : (
            <>
              {r.takes && r.takes.all > 0 && (
                <>
                  {" "}
                  <span class={`tcount mono${r.takes.fresh > 0 ? " new" : ""}`}>{r.takes.fresh > 0 ? `${r.takes.fresh} new` : r.takes.all}</span>
                </>
              )}
              {r.todo > 0 && <span class="dot" title={`${r.todo} open`} />}
            </>
          )}
        </button>
      ))}
    </nav>
  );
}
