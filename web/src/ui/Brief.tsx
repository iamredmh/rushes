// §24 step 2, §27, §38.3: the Brief page. brief.md is the file of record. The page reads like a document: an At a glance
// card first (the agent's `## At a glance` section, or one made from the other sections), the headings as chips, then
// each section as text with an Edit button. An edit is marked word by word against the agent's wording. Approving sets
// the file's Status line; editing afterwards reopens it. A film after the first builds on the project brief (the root
// brief.md), shown read-only; a film with no brief of its own shows the project brief and asks for one.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { glanceFallback, glanceIndex, parseGlance, type GlanceItem } from "../../../src/core/glance.js";
import { safeMarkdownHtml } from "../markdown.js";
import type { BriefSectionView, BriefView } from "../types.js";
import { useRecordSaves } from "./useRecordSaves.js";
import { AskAgent } from "./AskAgent.js";
import { Icon } from "./Icon.js";
import { EditedMark, PlanField, PlanStatus, useDebounced } from "./Planning.js";

const SAVE_AFTER_MS = 500;
/** A section longer than this many lines is shown cut down, with Show all. */
const LONG_LINES = 12;

interface Saver {
  section(s: BriefSectionView, text: string): void;
  status(status: "draft" | "approved"): void;
}

/** §38.3: the prompt that asks for a film's own brief, built on the project's. */
export function filmBriefPrompt(projectName: string, filmName: string, briefPath: string, projectPath = "brief.md"): string {
  return `In Rushes project "${projectName}", write the brief for the film "${filmName}" at ${briefPath}, from what we discussed in chat. Start it with "## At a glance": short "- Label: value" lines for Ask, Length, Audience, Deliver, Must and Never. Then write only what is different for this film from the project brief (${projectPath}): its ask, its length, its claims, its look. Don't copy the project brief. Put "Status: draft" under the title (see "Starting a film" in AGENTS.md).`;
}

/** §38.3: the prompt that asks for an At a glance section in a brief that has none. */
export function glancePrompt(projectName: string, briefPath: string): string {
  return `In Rushes project "${projectName}", add an "## At a glance" section to ${briefPath}, first after the title: short "- Label: value" lines for Ask, Length, Audience, Deliver, Must and Never, taken from the brief as it stands. Change nothing else.`;
}

/** The At a glance lines as a label grid: a label once, its values as a short list beside it. */
function GlanceBody({ items }: { items: GlanceItem[] }) {
  if (items.length === 0) return <p class="bgnone">Nothing here yet.</p>;
  return (
    <dl class="bglance">
      {items.map((it, i) =>
        it.label ? (
          <div class="bgrow" key={i}>
            <dt>{it.label}</dt>
            <dd>{it.values.length === 1 ? it.values[0] : <ul>{it.values.map((v, j) => <li key={j}>{v}</li>)}</ul>}</dd>
          </div>
        ) : (
          <div class="bgrow plain" key={i}>
            <dd>{it.values[0]}</dd>
          </div>
        ),
      )}
    </dl>
  );
}

/** Without an At a glance section: the first sentence of the first sections, marked as made by Rushes. */
function GlanceFallback({ sections }: { sections: { heading: string; body: string }[] }) {
  const lines = glanceFallback(sections);
  return (
    <dl class="bglance fallback">
      {lines.map((l, i) => (
        <div class="bgrow" key={i}>
          <dt>{l.heading}</dt>
          <dd>{l.sentence}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A section's text, rendered: cut down with Show all when it is long. */
function Rendered({ text }: { text: string }) {
  const html = useMemo(() => safeMarkdownHtml(text), [text]);
  const long = text.split(/\r?\n/).length > LONG_LINES;
  const [all, setAll] = useState(false);
  return (
    <div class="bread">
      <div class={`markdown${long && !all ? " clipped" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />
      {long && (
        <button class="btn ghost bmore" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/**
 * One section as a card: its heading, its text (or, for At a glance, the label grid), and Edit. Edit opens the field it
 * always had; Done, Escape or leaving the field closes it. `save` is null for a brief shown read-only.
 */
function SectionCard({ section, save, glance = false, id }: { section: BriefSectionView; save: Saver | null; glance?: boolean; id: string }) {
  const [text, setText] = useState(section.yours);
  const [open, setOpen] = useState(false);
  const editing = useRef(false);

  // The agent changed the section, or another window did: follow it unless you're mid-edit.
  useEffect(() => {
    if (!editing.current) setText(section.yours);
  }, [section.yours]);

  const saveText = useDebounced(() => {
    editing.current = false;
    if (save && text.trim() !== section.yours.trim()) save.section(section, text);
  }, SAVE_AFTER_MS);
  const changed = text.trim() !== section.current.trim();
  const close = () => {
    saveText.flush();
    setOpen(false);
  };

  return (
    <section id={id} class={`bcard${glance ? " glance" : ""}${changed ? " changed" : ""}`} data-section={section.heading} aria-label={section.heading}>
      <header class="bchead">
        <h3>{section.heading}</h3>
        {save &&
          (open ? (
            <button class="btn bedit" onMouseDown={(e) => e.preventDefault()} onClick={close}>
              <Icon name="check" />
              Done
            </button>
          ) : (
            <button class="btn bedit" aria-label={`Edit ${section.heading}`} onClick={() => setOpen(true)}>
              <Icon name="pencil" />
              Edit
            </button>
          ))}
      </header>
      {open && save ? (
        <PlanField
          label={`Your version of ${section.heading}`}
          value={text}
          autoFocus
          onInput={(t) => {
            editing.current = true;
            setText(t);
            saveText.schedule();
          }}
          onBlur={close}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
      ) : glance ? (
        <GlanceBody items={parseGlance(text)} />
      ) : (
        <Rendered text={text} />
      )}
      {changed && save && (
        <EditedMark
          baseline={[{ text: section.current, after: text }]}
          revertLabel={`Revert ${section.heading}`}
          onRevert={() => {
            editing.current = false;
            setText(section.current);
            setOpen(false);
            save.section(section, section.current);
          }}
        />
      )}
    </section>
  );
}

/** A section is found again by its heading and which of that heading it is, not by its position: the agent may add one above it. */
const occurrenceOf = (sections: BriefSectionView[], index: number): number => sections.slice(0, index).filter((x) => x.heading === sections[index].heading).length;

/**
 * A whole brief as cards: At a glance (its own or made from the sections), the headings as chips, then each section.
 * `save` null shows it read-only. `prefix` keeps two briefs on one page from sharing ids.
 */
function BriefBody({ brief, save, prefix, glancePromptText, toast, video = null }: { brief: BriefView; save: Saver | null; prefix: string; glancePromptText: string | null; toast(m: string): void; video?: string | null }) {
  const gi = glanceIndex(brief.sections);
  const rest = brief.sections.filter((_, i) => i !== gi);
  const sid = (s: BriefSectionView) => `${prefix}-${s.index}`;
  return (
    <>
      {gi >= 0 ? (
        <SectionCard key={`glance#${brief.sections[gi].heading}`} section={brief.sections[gi]} save={save} glance id={sid(brief.sections[gi])} />
      ) : (
        rest.length > 0 && (
          <section class="bcard glance" aria-label="At a glance">
            <header class="bchead">
              <h3>At a glance</h3>
              <span class="bfrom">From the sections</span>
            </header>
            <GlanceFallback sections={rest.map((s) => ({ heading: s.heading, body: s.yours }))} />
            {glancePromptText && (
              <p class="bask">
                <span>Ask your agent for an At a glance summary</span>
                <AskAgent prompt={glancePromptText} label="an At a glance for the brief" video={video} toast={toast} small copyWords="Copy prompt" />
              </p>
            )}
          </section>
        )
      )}
      {rest.length > 1 && (
        <nav class="bchips" aria-label="Sections">
          {rest.map((s) => (
            <button key={sid(s)} class="bchip" onClick={() => document.getElementById(sid(s))?.scrollIntoView({ block: "start", behavior: "smooth" })}>
              {s.heading}
            </button>
          ))}
        </nav>
      )}
      <div class="bcards">
        {rest.map((s) => (
          <SectionCard key={`${s.heading}#${occurrenceOf(brief.sections, s.index)}`} section={s} save={save} id={sid(s)} />
        ))}
      </div>
    </>
  );
}

/**
 * brief.md as a page to read, with Edit on each part and Approve at the foot. `settle` is how Send waits for what you just
 * typed: it resolves once every queued save has landed, with the brief as the server now has it.
 */
export function Brief({
  brief,
  projectBrief = null,
  projectName = "",
  filmName = null,
  briefPath = "brief.md",
  video = null,
  toast,
  onChanged,
  settle,
}: {
  brief: BriefView;
  projectBrief?: BriefView | null;
  projectName?: string;
  filmName?: string | null;
  briefPath?: string;
  video?: string | null;
  toast(message: string): void;
  onChanged(): void;
  settle: { current: (() => Promise<unknown>) | null };
}) {
  const { latest, enqueue } = useRecordSaves("brief", brief, { toast, onChanged, settle, video });
  const [showProject, setShowProject] = useState(false);
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

  // §38.3: a film after the first with no brief of its own: the project brief, read-only, and a way to ask for one.
  if (!brief.exists && projectBrief?.exists) {
    const prompt = filmBriefPrompt(projectName, filmName ?? "this film", briefPath);
    return (
      <div class="col ppage bpage">
        <div class="shead">
          <h2>Brief</h2>
          {filmName && <span class="meta">{filmName}</span>}
        </div>
        <div class="bnotice" role="note">
          <p>
            <b>This film has no brief of its own yet.</b> Ask your agent to write one from your chat. Until then, here is the project brief it builds on.
          </p>
          <AskAgent prompt={prompt} label={`the ${filmName ?? "film"} brief`} video={video} toast={toast} />
        </div>
        <div class="bproject readonly" aria-label="The project brief">
          <p class="bplabel">Project brief{projectBrief.title ? ` · ${projectBrief.title}` : ""}</p>
          <BriefBody brief={projectBrief} save={null} prefix="pb" glancePromptText={null} toast={toast} />
        </div>
      </div>
    );
  }

  const approved = brief.status === "approved";
  const projectGlance = projectBrief?.exists ? glanceIndex(projectBrief.sections) : -1;
  return (
    <div class="col ppage bpage">
      <div class="shead">
        <h2>Brief</h2>
        {brief.title && <span class="meta">{brief.title}</span>}
      </div>
      {projectBrief?.exists && (
        <div class="bbuilds">
          <p>
            <Icon name="brief" />
            Builds on the project brief{projectBrief.title ? `: ${projectBrief.title}` : ""}
          </p>
          <button class="btn ghost" aria-expanded={showProject} onClick={() => setShowProject(!showProject)}>
            {showProject ? "Hide" : "Show"}
          </button>
          {showProject && (
            <div class="bproject readonly" aria-label="The project brief, at a glance">
              {projectGlance >= 0 ? (
                <GlanceBody items={parseGlance(projectBrief.sections[projectGlance].yours)} />
              ) : (
                <GlanceFallback sections={projectBrief.sections.map((s) => ({ heading: s.heading, body: s.yours }))} />
              )}
            </div>
          )}
        </div>
      )}
      {brief.sections.length === 0 && <p class="sbnone">brief.md has no ## sections yet. Your agent adds them as `## At a glance`, `## Purpose` and so on.</p>}
      <BriefBody brief={brief} save={save} prefix="b" glancePromptText={glancePrompt(projectName, briefPath)} toast={toast} video={video} />
      <PlanStatus counts={brief.sections.length > 0 ? { approved: approved ? "Brief approved" : "Brief not approved yet", edited: brief.changed } : null}>
        <button class={`btn bapprove${approved ? " approved" : ""}`} aria-pressed={approved} onClick={() => save.status(approved ? "draft" : "approved")}>
          <Icon name="check" />
          {approved ? "Approved" : "Approve brief"}
        </button>
      </PlanStatus>
    </div>
  );
}
