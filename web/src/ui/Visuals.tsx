// §25: the Visuals tab. Stills and carousels, one page at a time in a large frame, marked up region by region. The page
// scrolls between visuals; whichever one crosses the middle of the view is the current one, and a note can only be added
// to it. The rules (the strip window, the shape of a drag, the groups and numbers) are in ../visuals.ts.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { labelOfId } from "../../../src/core/formats.js";
import { pinWords, regionWords } from "../../../src/core/visualWords.js";
import { api, ApiError, mediaUrl } from "../api.js";
import type { Note, State, Visual } from "../types.js";
import {
  STRIP_VISIBLE, boxesOn, canMark, defaultView, dragRefusal, groupNotes, newest, noteNo, notePage, noteVisual, openByPage, shapeFromDrag, stripStart,
  remember, resolveView, targetLabel, viewForNote, type Draft, type Shape, type StoredView, type View,
} from "../visuals.js";
import { Icon } from "./Icon.js";

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Fits a picture of this shape inside whatever room its box has, and says its size. */
function useFit(ratio: { w: number; h: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const k = Math.min(r.width / ratio.w, r.height / ratio.h);
      setSize(k > 0 && Number.isFinite(k) ? { w: Math.floor(ratio.w * k), h: Math.floor(ratio.h * k) } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio.w, ratio.h]);
  return { box, size };
}

/** The marks on a picture, drawn over it. */
function Marks({ notes, all, selected, draft }: { notes: Note[]; all: Note[]; selected: string | null; draft: Draft | null }) {
  return (
    <>
      {notes.map((n) => {
        const no = noteNo(all, n);
        const cls = `${n.status === "done" ? " done" : ""}${selected === n.id ? " sel" : ""}`;
        return n.pin ? (
          <div key={n.id} class={`vzpin${cls}`} data-note={n.id} style={{ left: `${n.pin.x * 100}%`, top: `${n.pin.y * 100}%` }}>
            <span class="no">{no}</span>
          </div>
        ) : n.box ? (
          <div key={n.id} class={`vzbox${cls}`} data-note={n.id} style={{ left: `${n.box.x * 100}%`, top: `${n.box.y * 100}%`, width: `${n.box.w * 100}%`, height: `${n.box.h * 100}%` }}>
            <span class="no">{no}</span>
          </div>
        ) : null;
      })}
      {draft && draft.shape && "pin" in draft.shape && (
        <div class="vzpin draft" style={{ left: `${draft.shape.pin.x * 100}%`, top: `${draft.shape.pin.y * 100}%` }}>
          <span class="no">{all.filter((n) => n.stage === "visuals" && noteVisual(n) === draft.vis).length + 1}</span>
        </div>
      )}
      {draft && draft.shape && "box" in draft.shape && (
        <div class="vzbox draft" style={{ left: `${draft.shape.box.x * 100}%`, top: `${draft.shape.box.y * 100}%`, width: `${draft.shape.box.w * 100}%`, height: `${draft.shape.box.h * 100}%` }}>
          <span class="no">{all.filter((n) => n.stage === "visuals" && noteVisual(n) === draft.vis).length + 1}</span>
        </div>
      )}
    </>
  );
}

function Picture({ file, alt, onBad }: { file: string; alt: string; onBad(): void }) {
  return <img src={mediaUrl(file)} alt={alt} draggable={false} onError={onBad} />;
}

/** The page strip: about eight pages in view, the active one first. */
function Strip({ visual, view, badges, onPage }: { visual: Visual; view: View; badges: Record<number, number>; onPage(p: number): void }) {
  const ver = visual.versions.find((v) => v.id === view.ver) ?? newest(visual);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.children.length === 0) return;
    const first = el.children[stripStart(view.page, ver.pages.length)] as HTMLElement | undefined;
    if (first) el.scrollTo({ left: first.offsetLeft - (el.children[0] as HTMLElement).offsetLeft, behavior: "auto" });
  }, [view.page, ver.pages.length]);
  // Each thumbnail is 62px tall and as wide as its picture's shape makes it; the strip is as wide as eight of them.
  const first = ver.pages[0]?.images.find((i) => i.ratio === view.ratio) ?? ver.pages[0]?.images[0];
  const tw = first ? (62 * first.width) / first.height : 50;
  return (
    <div class="vzthumbs" ref={ref} style={{ maxWidth: `${STRIP_VISIBLE * tw + (STRIP_VISIBLE - 1) * 8 + 4}px`, "--vzth": `${tw}px` } as Record<string, string>}>
      {ver.pages.map((p) => {
        const img = p.images.find((i) => i.ratio === view.ratio) ?? p.images[0];
        return (
          <button key={p.n} class="vzth" style={{ width: `${tw}px` }} aria-label={`Page ${p.n}`} aria-current={p.n === view.page ? "true" : undefined} onClick={() => onPage(p.n)}>
            <img src={mediaUrl(img.file)} alt="" draggable={false} loading="lazy" decoding="async" />
            <span class="pn">{p.n}</span>
            {badges[p.n] ? <span class="badge">{badges[p.n]}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Section({
  visual, view, current, notes, selected, draft, verMenu, onSetView, onVerMenu, onFull, onPointer, onNotePick,
}: {
  visual: Visual;
  view: View;
  current: boolean;
  notes: Note[];
  selected: string | null;
  draft: Draft | null;
  verMenu: boolean;
  onSetView(v: Partial<View>): void;
  onVerMenu(open: boolean): void;
  onFull(): void;
  onPointer(e: PointerEvent, frame: HTMLElement): void;
  onNotePick(id: string): void;
}) {
  const ver = visual.versions.find((v) => v.id === view.ver) ?? newest(visual);
  const page = ver.pages.find((p) => p.n === view.page) ?? ver.pages[0];
  const image = page.images.find((i) => i.ratio === view.ratio) ?? page.images[0];
  const ratios = ver.pages[0]?.images ?? [];
  const { box, size } = useFit({ w: image.width, h: image.height });
  const [bad, setBad] = useState<string | null>(null);
  const marks = boxesOn(notes, visual.id, view);
  const shownDraft = draft && draft.vis === visual.id && draft.page === view.page && draft.ratio === view.ratio && draft.ver === view.ver ? draft : null;
  const older = !canMark(visual, view);
  const count = String(view.page).padStart(2, "0");
  return (
    <section class={`vz${current ? " cur" : ""}`} data-visual={visual.id} aria-label={visual.name} aria-current={current ? "true" : undefined}>
      <div class="vzhead">
        <h2>{visual.name}</h2>
        <span class="vzkind">{visual.kind}{visual.kind === "carousel" ? ` · ${ver.pages.length} pages` : ""}</span>
        {visual.versions.length > 1 ? (
          <span class="vzver">
            <button class="vzchip" aria-haspopup="menu" aria-expanded={verMenu} onClick={() => onVerMenu(!verMenu)}>
              {view.ver}
              <Icon name="chev" />
            </button>
            {verMenu && (
              <div class="vzvermenu" role="menu">
                {[...visual.versions].reverse().map((v) => (
                  <button key={v.id} role="menuitem" aria-current={v.id === view.ver ? "true" : undefined} onClick={() => { onVerMenu(false); onSetView({ ver: v.id }); }}>
                    {v.id}
                    <span>{v.label || (v.id === newest(visual).id ? "newest" : "older")}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        ) : (
          <span class="vzchip static">{view.ver}</span>
        )}
        {ratios.length > 1 ? (
          ratios.map((i) => (
            <button key={i.ratio} class="vzchip" aria-pressed={i.ratio === view.ratio} onClick={() => onSetView({ ratio: i.ratio })}>
              {labelOfId(i.ratio)}
            </button>
          ))
        ) : (
          <span class="vzchip static">{image.width}×{image.height}</span>
        )}
        {older && <span class="vzbanner">Viewing {view.ver}, an older version</span>}
      </div>
      <div class="vzfwrap" ref={box}>
        <div
          class="vzframe"
          data-frame={visual.id}
          role="img"
          aria-label={`${targetLabel(visual, view)}`}
          style={size ? { width: `${size.w}px`, height: `${size.h}px` } : { visibility: "hidden" }}
          onPointerDown={(e) => onPointer(e as unknown as PointerEvent, e.currentTarget as HTMLElement)}
        >
          {bad === image.file ? (
            <div class="vzbad">Can't load page {view.page}: {image.file}</div>
          ) : (
            <Picture key={image.file} file={image.file} alt={`${visual.name}, page ${view.page}`} onBad={() => setBad(image.file)} />
          )}
          <Marks notes={marks} all={notes} selected={selected} draft={shownDraft} />
        </div>
      </div>
      <div class="vzfoot">
        {visual.kind === "carousel" ? (
          <>
            <div class="vznav">
              <button class="btn vzpill" aria-label="Previous page" disabled={view.page <= 1} onClick={() => onSetView({ page: view.page - 1 })}>Previous</button>
              <span class="vzcount" aria-label={`Page ${view.page} of ${ver.pages.length}`}>{count} / {String(ver.pages.length).padStart(2, "0")}</span>
              <button class="btn vzpill" onClick={onFull}>Full screen</button>
              <button class="btn vzpill primary" aria-label="Next page" disabled={view.page >= ver.pages.length} onClick={() => onSetView({ page: view.page + 1 })}>Next</button>
            </div>
            <Strip visual={visual} view={view} badges={openByPage(notes, visual.id)} onPage={(p) => onSetView({ page: p })} />
          </>
        ) : (
          <div class="vznav">
            <button class="btn vzpill" onClick={onFull}>Full screen</button>
            <span class="vzhint">One page{ratios.length > 1 ? ` · ${ratios.length} ratios` : ""}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function FullScreen({ visual, view, notes, onPage, onClose }: { visual: Visual; view: View; notes: Note[]; onPage(p: number): void; onClose(): void }) {
  const ver = visual.versions.find((v) => v.id === view.ver) ?? newest(visual);
  const page = ver.pages.find((p) => p.n === view.page) ?? ver.pages[0];
  const image = page.images.find((i) => i.ratio === view.ratio) ?? page.images[0];
  const { box, size } = useFit({ w: image.width, h: image.height });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.focus(), []);
  return (
    <div class="vzfs" role="dialog" aria-label="Full screen" aria-modal="true" tabIndex={-1} ref={root}>
      <div class="stg" ref={box}>
        <div class="vzframe" data-frame={visual.id} style={size ? { width: `${size.w}px`, height: `${size.h}px` } : { visibility: "hidden" }}>
          <Picture key={image.file} file={image.file} alt={`${visual.name}, page ${view.page}`} onBad={() => undefined} />
          <Marks notes={boxesOn(notes, visual.id, view)} all={notes} selected={null} draft={null} />
        </div>
      </div>
      <div class="bar">
        {visual.kind === "carousel" && (
          <>
            <button class="btn vzpill" aria-label="Previous page" disabled={view.page <= 1} onClick={() => onPage(view.page - 1)}>Previous</button>
            <span class="vzcount">{String(view.page).padStart(2, "0")} / {String(ver.pages.length).padStart(2, "0")}</span>
            <button class="btn vzpill primary" aria-label="Next page" disabled={view.page >= ver.pages.length} onClick={() => onPage(view.page + 1)}>Next</button>
          </>
        )}
        <button class="btn vzpill" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export function Visuals({ state, toast, onChanged, onPendingChange }: { state: State; toast(message: string): void; onChanged(): void; onPendingChange(p: boolean): void }) {
  const visuals = state.visuals.visuals;
  const all = state.notes.notes;
  const [cur, setCur] = useState(visuals[0]?.id ?? "");
  // A visual's remembered view. An older version is kept only as a look back, until a newer one is registered; otherwise the view follows the newest.
  const [views, setViews] = useState<Record<string, StoredView>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [fs, setFs] = useState<string | null>(null);
  const [verMenu, setVerMenu] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);

  const viewOf = (v: Visual): View => resolveView(v, views[v.id]);
  const visual = visuals.find((v) => v.id === cur) ?? visuals[0];
  const setView = (v: Visual, patch: Partial<View>) => {
    setViews((m) => {
      const next = { ...viewOf(v), ...patch };
      // A page or version that does not exist (a version with fewer pages, a ratio it lacks) falls back to one that does.
      const ver = v.versions.find((x) => x.id === next.ver) ?? newest(v);
      const pg = Math.max(1, Math.min(ver.pages.length, next.page));
      const ratio = ver.pages[0]?.images.some((i) => i.ratio === next.ratio) ? next.ratio : (ver.pages[0]?.images[0]?.ratio ?? next.ratio);
      return { ...m, [v.id]: remember(v, { page: pg, ratio, ver: ver.id }) };
    });
  };

  // Which visual is current: the one the middle of the scroll area is in. It is read from where the line is (on scroll and on resize),
  // never from which visual last started to cross it: with two touching the line at once, the last to be reported could be the wrong one.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let frame = 0;
    const pick = () => {
      frame = 0;
      const line = root.getBoundingClientRect().top + root.clientHeight / 2;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(".vz"))) {
        const r = el.getBoundingClientRect();
        if (r.top <= line && line < r.bottom) return void setCur(el.dataset.visual ?? "");
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(pick);
    };
    root.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    root.querySelectorAll(".vz").forEach((el) => ro.observe(el));
    pick();
    return () => {
      root.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [visuals.map((v) => v.id).join(",")]);

  const scrollTo = (id: string, smooth = true) => {
    const el = scroller.current?.querySelector<HTMLElement>(`.vz[data-visual="${id}"]`);
    if (el) scroller.current!.scrollTo({ top: el.offsetTop, behavior: smooth ? "smooth" : "instant" });
  };

  // Words in a draft hold the tab, as a half-typed note does on the others.
  useEffect(() => {
    onPendingChange(!!draft && draft.text.trim() !== "");
    return () => onPendingChange(false);
  }, [draft?.text]);

  const startMark = (e: PointerEvent, frame: HTMLElement, v: Visual) => {
    if (e.button !== 0) return;
    if (v.id !== cur) {
      scrollTo(v.id);
      return;
    }
    const view = viewOf(v);
    if (!canMark(v, view)) return toast(`You're looking at ${view.ver}. Switch to the newest version to add notes.`);
    const refused = dragRefusal(draft, { vis: v.id, ...view }, draft ? (visuals.find((x) => x.id === draft.vis)?.name ?? "") : "");
    if (refused) return toast(refused);
    e.preventDefault();
    const r = frame.getBoundingClientRect();
    const at = (x: number, y: number) => ({ x: (x - r.left) / r.width, y: (y - r.top) / r.height });
    const a = at(e.clientX, e.clientY);
    const [px, py] = [e.clientX, e.clientY];
    let moved = false;
    const hold = frame.setPointerCapture ? (frame.setPointerCapture(e.pointerId), true) : false;
    const preview = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - px, ev.clientY - py) > 5) moved = true;
      if (moved) setDraft((d) => ({ vis: v.id, text: d && d.vis === v.id ? d.text : "", ...view, shape: shapeFromDrag(a, at(ev.clientX, ev.clientY), true) ?? { box: { x: a.x, y: a.y, w: 0, h: 0 } } }));
    };
    const before = draft;
    const cancel = () => {
      frame.removeEventListener("pointermove", preview);
      frame.removeEventListener("pointerup", done);
      frame.removeEventListener("pointercancel", cancel);
      if (hold) frame.releasePointerCapture?.(e.pointerId);
      setDraft(before);
    };
    const done = (ev: PointerEvent) => {
      frame.removeEventListener("pointermove", preview);
      frame.removeEventListener("pointerup", done);
      frame.removeEventListener("pointercancel", cancel);
      const shape: Shape | null = shapeFromDrag(a, at(ev.clientX, ev.clientY), moved);
      if (hold) frame.releasePointerCapture?.(e.pointerId);
      if (!shape) return setDraft((d) => (d && d.text.trim() === "" ? null : d));
      setDraft((d) => ({ vis: v.id, text: d && d.vis === v.id ? d.text : "", ...view, shape }));
      queueMicrotask(() => text.current?.focus());
    };
    frame.addEventListener("pointermove", preview);
    frame.addEventListener("pointerup", done);
    frame.addEventListener("pointercancel", cancel);
  };

  const target = draft ? visuals.find((v) => v.id === draft.vis) : null;
  const here = visual ? { vis: visual.id, ...viewOf(visual) } : null;
  // Where the draft will go differs from what is in view: another visual, another page, another version, or (for a mark) another ratio.
  const away = !!(draft && here && (draft.vis !== here.vis || draft.page !== here.page || draft.ver !== here.ver || ((draft.shape || draft.justThis) && draft.ratio !== here.ratio)));
  const justThisOffered = !!target && target.versions.find((v) => v.id === draft?.ver)?.pages[0]?.images.length! > 1;

  const startWhole = () => {
    if (!visual) return;
    const view = viewOf(visual);
    if (!canMark(visual, view)) return toast(`You're looking at ${view.ver}. Switch to the newest version to add notes.`);
    const refused = dragRefusal(draft, { vis: visual.id, ...view }, draft ? (visuals.find((x) => x.id === draft.vis)?.name ?? "") : "");
    if (refused) return toast(refused);
    setDraft({ vis: visual.id, ...view, shape: null, text: draft?.text ?? "" });
    queueMicrotask(() => text.current?.focus());
  };

  const adding = useRef(false);
  const [saving, setSaving] = useState(false);
  const add = async () => {
    if (adding.current) return;
    const d = draft ?? (visual ? { vis: visual.id, ...viewOf(visual), shape: null, text: "" } : null);
    if (!d) return;
    const body = (text.current?.value ?? d.text).trim();
    if (!body) {
      toast("Write the note first.");
      return text.current?.focus();
    }
    const v = visuals.find((x) => x.id === d.vis)!;
    if (!canMark(v, d)) return toast(`This note is for ${d.ver}, an older version. Switch to the newest version to add notes.`);
    const shaped = !!d.shape;
    const format = shaped || d.justThis ? d.ratio : null;
    // A second press while the first is still on its way would save the same note twice.
    adding.current = true;
    setSaving(true);
    try {
      const r = await api.post<{ note: Note }>("/api/notes", {
        stage: "visuals", scope: "whole", version: d.ver, on: `${d.vis}/${d.page}`, format, text: body,
        ...(d.shape && "box" in d.shape ? { box: d.shape.box } : {}),
        ...(d.shape && "pin" in d.shape ? { pin: d.shape.pin } : {}),
      });
      setDraft(null);
      setSel(r.note.id);
      onChanged();
      void v;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      adding.current = false;
      setSaving(false);
    }
  };

  const tick = async (n: Note) => {
    try {
      await api.patch(`/api/notes/${n.id}`, { status: n.status === "done" ? "todo" : "done" });
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const openNote = (n: Note) => {
    const v = visuals.find((x) => x.id === noteVisual(n));
    if (!v) return;
    setSel(n.id);
    setView(v, viewForNote(v, n, viewOf(v)));
    scrollTo(v.id);
    setCur(v.id);
    setTimeout(() => {
      const b = document.querySelector<HTMLElement>(`.vz [data-note="${n.id}"]`);
      if (b) {
        b.classList.remove("flash");
        void b.offsetWidth;
        b.classList.add("flash");
      }
    }, 350);
  };

  // Keys for the current visual. They do nothing while a text box has the focus, and the full-screen dialog has its own.
  // The handler is read from a ref, so a key pressed right after a click never meets the previous render's closure.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const forward = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", forward);
    return () => window.removeEventListener("keydown", forward);
  }, []);
  {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !visual) return;
      if (fs) {
        const f = visuals.find((v) => v.id === fs);
        if (!f) return;
        if (e.key === "Escape") setFs(null);
        else if (f.kind === "carousel" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
          e.preventDefault();
          setView(f, { page: viewOf(f).page + (e.key === "ArrowRight" ? 1 : -1) });
        }
        return;
      }
      if (typing(e.target)) return;
      const view = viewOf(visual);
      const i = visuals.findIndex((v) => v.id === visual.id);
      if (e.key === "ArrowRight" && visual.kind === "carousel") {
        e.preventDefault();
        setView(visual, { page: view.page + 1 });
      } else if (e.key === "ArrowLeft" && visual.kind === "carousel") {
        e.preventDefault();
        setView(visual, { page: view.page - 1 });
      } else if (e.key === "ArrowDown" && i < visuals.length - 1) {
        e.preventDefault();
        scrollTo(visuals[i + 1].id);
      } else if (e.key === "ArrowUp" && i > 0) {
        e.preventDefault();
        scrollTo(visuals[i - 1].id);
      } else if (e.key === "r" || e.key === "R") {
        const ratios = newestRatios(visual, view);
        if (ratios.length > 1) setView(visual, { ratio: ratios[(ratios.indexOf(view.ratio) + 1) % ratios.length] });
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        text.current?.focus();
      } else if (e.key === "Escape") setDraft(null);
    };
    onKeyRef.current = onKey;
  }
  useEffect(() => {
    if (!verMenu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest(".vzver")) setVerMenu(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [verMenu]);

  if (!visual) return null;
  const groups = groupNotes(visuals, all);
  const openTotal = all.filter((n) => n.stage === "visuals" && n.status === "todo").length;
  const openVisuals = new Set(all.filter((n) => n.stage === "visuals" && n.status === "todo").map(noteVisual)).size;
  const fsVisual = fs ? visuals.find((v) => v.id === fs) : null;

  return (
    <div class="vzsplit">
      <div class="vzscroll" ref={scroller}>
        {visuals.map((v) => (
          <Section
            key={v.id}
            visual={v}
            view={viewOf(v)}
            current={v.id === cur}
            notes={all}
            selected={sel}
            draft={draft}
            verMenu={verMenu === v.id}
            onSetView={(p) => setView(v, p)}
            onVerMenu={(o) => setVerMenu(o ? v.id : null)}
            onFull={() => setFs(v.id)}
            onPointer={(e, frame) => startMark(e, frame, v)}
            onNotePick={(id) => setSel(id)}
          />
        ))}
      </div>
      <aside class="vznotes" aria-label="Visual notes">
        <div class="vznhead">
          <h3>Notes</h3>
          <span>{openTotal} open across {openVisuals} visual{openVisuals === 1 ? "" : "s"}</span>
        </div>
        <div class="vznlist">
          {groups.length === 0 && <div class="vzempty">No notes yet.</div>}
          {groups.map((g) => (
            <div key={g.visual.id} class={`vzgrp${g.visual.id === cur ? " cur" : ""}`} data-grp={g.visual.id}>
              <button class="vzghead" onClick={() => !g.gone && scrollTo(g.visual.id)}>
                {g.visual.name}
                {g.visual.id === cur && <span class="here">looking at</span>}
                <span class="cnt">{g.open} open</span>
              </button>
              <div class="vzpg">
                {g.pages.map((pg) => (
                  <div key={pg.page}>
                    <div class="vzpgh">{visuals.find((v) => v.id === g.visual.id)?.kind === "carousel" ? `Page ${pg.page}` : "Page 1"}</div>
                    {pg.notes.map((n) => {
                      const v = visuals.find((x) => x.id === g.visual.id);
                      const old = v && n.version && n.version !== newest(v).id;
                      return (
                        <div key={n.id} class={`vznote${n.status === "done" ? " done" : ""}${sel === n.id ? " sel" : ""}`} data-note={n.id} role="button" tabIndex={0} onClick={() => openNote(n)} onKeyDown={(e) => e.key === "Enter" && openNote(n)}>
                          <span class="no2">{noteNo(all, n)}</span>
                          <div class="txt">
                            <span class="t">{n.text}</span>
                            <span class="tags">
                              <span class="tag">{n.format ? labelOfId(n.format) : "all ratios"}</span>
                              <span class={`tag${old ? " old" : ""}`}>{old ? `from ${n.version}` : n.version}</span>
                              <span class="tag" title={n.box ? regionWords(n.box) : n.pin ? pinWords(n.pin) : undefined}>{n.box ? "region" : n.pin ? "point" : "whole image"}</span>
                            </span>
                            {n.reply && (
                              <div class="vzreply">
                                <b>Agent</b> {n.reply}
                                {n.fixVersion && v && (
                                  <button class="vzlink" onClick={(e) => { e.stopPropagation(); setSel(n.id); setView(v, { ...viewForNote(v, n, viewOf(v)), ver: n.fixVersion! }); scrollTo(v.id); }}>Show in {n.fixVersion}</button>
                                )}
                              </div>
                            )}
                          </div>
                          <button class="vztick" aria-label={n.status === "done" ? "Reopen" : "Mark done"} data-tip={n.status === "done" ? "Reopen" : "Mark done"} onClick={(e) => { e.stopPropagation(); void tick(n); }}>
                            <Icon name={n.status === "done" ? "check" : "circle"} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div class="vzcomposer">
          <div class={`vztarget${away ? " away" : ""}`}>
            <span class="lbl">{away ? "Draft for" : "Adding to"}</span>
            <b>{away && target ? targetLabel(target, draft!) : targetLabel(visual, viewOf(visual))}</b>
            {away && <button class="btn" onClick={() => scrollTo(draft!.vis)}>Go to it</button>}
          </div>
          <textarea
            ref={text}
            aria-label="Note text"
            placeholder={draft ? (draft.shape ? `${draft.shape && "pin" in draft.shape ? "A point" : "A region"} is marked. Write what to change.` : "No region: this note is for the whole image.") : "Drag on the picture to mark a region, click for a point, or add a whole-image note."}
            value={draft?.text ?? ""}
            onInput={(e) => {
              const t = (e.currentTarget as HTMLTextAreaElement).value;
              setDraft((d) => (d ? { ...d, text: t } : visual ? { vis: visual.id, ...viewOf(visual), shape: null, text: t } : d));
            }}
            onKeyDown={(e) => {
              // Return adds the note, as it does on every other tab; Shift+Return is a new line.
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if ((e.currentTarget as HTMLTextAreaElement).value.trim()) void add();
              }
              if (e.key === "Escape") {
                e.stopPropagation();
                setDraft(null);
                (e.currentTarget as HTMLTextAreaElement).blur();
              }
            }}
          />
          {draft && !draft.shape && justThisOffered && (
            <label class="vzjust">
              <input type="checkbox" checked={!!draft.justThis} onChange={(e) => setDraft({ ...draft, justThis: (e.currentTarget as HTMLInputElement).checked })} />
              Just {labelOfId(draft.ratio)}
            </label>
          )}
          <div class="vzcrow">
            <button class="btn primary" disabled={saving} onClick={() => void add()}>Add note</button>
            <button class="btn" onClick={startWhole}>Whole image</button>
            <button class="btn ghost" disabled={!draft} onClick={() => setDraft(null)}>{draft?.text ? "Discard draft" : "Cancel"}</button>
          </div>
        </div>
      </aside>
      {fsVisual && <FullScreen visual={fsVisual} view={viewOf(fsVisual)} notes={all} onPage={(p) => setView(fsVisual, { page: p })} onClose={() => setFs(null)} />}
    </div>
  );
}

function newestRatios(v: Visual, view: View): string[] {
  const ver = v.versions.find((x) => x.id === view.ver) ?? newest(v);
  return ver.pages[0]?.images.map((i) => i.ratio) ?? [];
}
