// §24 step 2, §27: the Brief page. brief.md is the file of record: each section is a field holding your version, marked
// "Edited by you" over the agent's wording when they differ, and a save writes the file. Approving sets its Status line;
// editing afterwards reopens it.
import { useEffect, useRef, useState } from "preact/hooks";
import type { BriefSectionView, BriefView } from "../types.js";
import { useRecordSaves } from "./useRecordSaves.js";
import { Icon } from "./Icon.js";
import { EditedMark, PlanField, PlanStatus, useDebounced } from "./Planning.js";

const SAVE_AFTER_MS = 500;

interface Saver {
  section(s: BriefSectionView, text: string): void;
  status(status: "draft" | "approved"): void;
}

function Row({ section, save }: { section: BriefSectionView; save: Saver }) {
  const [text, setText] = useState(section.yours);
  const editing = useRef(false);

  // The agent changed the section, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(section.yours);
  }, [section.yours]);

  const saveText = useDebounced(() => {
    editing.current = false;
    if (text.trim() !== section.yours.trim()) save.section(section, text);
  }, SAVE_AFTER_MS);
  const changed = text.trim() !== section.current.trim();

  return (
    <div class={`srow brow${changed ? " changed" : ""}`} data-section={section.heading}>
      <div class="plabel">{section.heading}</div>
      <div class="pbody">
        <PlanField
          label={`Your version of ${section.heading}`}
          value={text}
          onInput={(t) => {
            editing.current = true;
            setText(t);
            saveText.schedule();
          }}
          onBlur={() => saveText.flush()}
        />
        {changed && (
          <EditedMark
            baseline={[{ text: section.current }]}
            revertLabel={`Revert ${section.heading}`}
            onRevert={() => {
              editing.current = false;
              setText(section.current);
              save.section(section, section.current);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** A section is found again by its heading and which of that heading it is, not by its position: the agent may add one above it. */
const occurrenceOf = (sections: BriefSectionView[], index: number): number => sections.slice(0, index).filter((x) => x.heading === sections[index].heading).length;

/**
 * brief.md: one field per section, your version over the agent's when you've changed it, and an Approve at the foot.
 * `settle` is how Send waits for what you just typed: it resolves once every queued save has landed,
 * with the brief as the server now has it.
 */
export function Brief({ brief, video = null, toast, onChanged, settle }: { brief: BriefView; video?: string | null; toast(message: string): void; onChanged(): void; settle: { current: (() => Promise<unknown>) | null } }) {
  const { latest, enqueue } = useRecordSaves("brief", brief, { toast, onChanged, settle, video });
  const save: Saver = {
    section: (s, text) => {
      const nth = occurrenceOf(latest.current.sections, s.index);
      enqueue(s.heading, (b) => {
        const at = b.sections.filter((x) => x.heading === s.heading)[nth];
        return at ? { path: `/api/brief/sections/${at.index}`, body: { heading: s.heading, text } } : null;
      });
    },
    status: (status) => {
      // Approving is only for the text you saw: if the agent has rewritten the brief since, the tick is not carried over to the new words.
      const seen = brief.sections.map((x) => `${x.heading}\n${x.yours}`).join("\n\n");
      enqueue("the brief's status", (b, fresh) => {
        if (fresh && status === "approved" && b.sections.map((x) => `${x.heading}\n${x.yours}`).join("\n\n") !== seen) {
          return { refuse: "the agent changed the brief while you were looking at it. Read it again, then approve." };
        }
        return { path: "/api/brief/status", body: { status } };
      });
    },
  };

  const approved = brief.status === "approved";
  return (
    <div class="col ppage">
      <div class="shead">
        <h2>Brief</h2>
        {brief.title && <span class="meta">{brief.title}</span>}
      </div>
      {brief.sections.length === 0 && <p class="sbnone">brief.md has no ## sections yet. Your agent adds them as `## Purpose`, `## Audience` and so on.</p>}
      <div class="prows">
        {brief.sections.map((s) => <Row key={`${s.heading}#${occurrenceOf(brief.sections, s.index)}`} section={s} save={save} />)}
      </div>
      <PlanStatus counts={brief.sections.length > 0 ? { approved: approved ? "Brief approved" : "Brief not approved yet", edited: brief.changed } : null}>
        <button class={`btn bapprove${approved ? " approved" : ""}`} aria-pressed={approved} onClick={() => save.status(approved ? "draft" : "approved")}>
          <Icon name="check" />
          {approved ? "Approved" : "Approve brief"}
        </button>
      </PlanStatus>
    </div>
  );
}
