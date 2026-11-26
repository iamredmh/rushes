// §37.5: one tooltip layer for the whole page. Every element with `data-tip` gets its tooltip drawn by a single
// fixed-position element at the root, so no panel's overflow ever clips it, and it is kept inside the window on both
// sides. It replaces the `[data-tip]::after` tooltip; call sites are unchanged.
//
// What used to be per-context CSS on `::after` is read from custom properties on the element:
//   --tip-side: above | below | right   where it goes when there's room (default above)
//   --tip-size: small                   the desk's smaller type
//   --tip-wrap: wrap | pre-line | clip  long tips wrap, keep their line breaks, or end in "…" (default: one line)
//   --tip-max: <length>                 the widest a wrapping tip gets (default 300px)
// plus the classes `.tip-below` and `.tip-wrap`, which still work as they did.

export type TipSide = "above" | "below" | "right";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Gap between the element and its tip, and the least room kept to the window's edges. */
export const TIP_GAP = 8;
export const TIP_MARGIN = 8;

/**
 * Where a tip of `size` goes for an element at `anchor` in a window of `view`: on `side` when it fits there,
 * otherwise flipped (above <-> below; right falls back to above, then below), then moved sideways (or up and down,
 * for right) so it stays at least TIP_MARGIN inside the window. Pure, for tests.
 */
export function placeTip(
  anchor: Rect,
  size: { width: number; height: number },
  view: { width: number; height: number },
  side: TipSide = "above",
): { left: number; top: number; side: TipSide } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const roomAbove = anchor.top - TIP_GAP - TIP_MARGIN;
  const roomBelow = view.height - (anchor.top + anchor.height) - TIP_GAP - TIP_MARGIN;
  if (side === "right") {
    const left = anchor.left + anchor.width + TIP_GAP;
    if (left + size.width <= view.width - TIP_MARGIN) {
      const top = clamp(anchor.top + anchor.height / 2 - size.height / 2, TIP_MARGIN, view.height - TIP_MARGIN - size.height);
      return { left, top, side: "right" };
    }
    side = "above";
  }
  let chosen: "above" | "below" = side;
  if (chosen === "above" && size.height > roomAbove && roomBelow > roomAbove) chosen = "below";
  else if (chosen === "below" && size.height > roomBelow && roomAbove > roomBelow) chosen = "above";
  const top = chosen === "above" ? anchor.top - TIP_GAP - size.height : anchor.top + anchor.height + TIP_GAP;
  const left = clamp(anchor.left + anchor.width / 2 - size.width / 2, TIP_MARGIN, view.width - TIP_MARGIN - size.width);
  return { left, top: clamp(top, TIP_MARGIN, view.height - TIP_MARGIN - size.height), side: chosen };
}

interface Look {
  side: TipSide;
  small: boolean;
  wrap: "" | "wrap" | "pre-line" | "clip";
  max: string;
}

/** The look an element asks for: its custom properties, then its classes. */
function lookOf(el: Element): Look {
  const cs = getComputedStyle(el);
  const prop = (name: string) => cs.getPropertyValue(name).trim();
  const sideProp = prop("--tip-side");
  const side: TipSide = el.classList.contains("tip-below") ? "below" : sideProp === "below" || sideProp === "right" ? sideProp : "above";
  const wrapProp = prop("--tip-wrap");
  const wrap = wrapProp === "pre-line" || wrapProp === "clip" ? wrapProp : wrapProp === "wrap" || el.classList.contains("tip-wrap") ? "wrap" : "";
  return { side, small: prop("--tip-size") === "small", wrap, max: prop("--tip-max") || "300px" };
}

/** The layer, once per document. Returns a function that removes it (for tests). */
export function installTips(doc: Document = document): () => void {
  const win = doc.defaultView ?? window;
  const layer = doc.createElement("div");
  layer.className = "tiplayer";
  layer.setAttribute("aria-hidden", "true");
  doc.body.appendChild(layer);

  let current: HTMLElement | null = null;
  let by: "hover" | "focus" | null = null;
  // Escape hides the tip until the pointer leaves the element or focus moves on.
  let silenced: HTMLElement | null = null;
  let frame = 0;
  const watch = new MutationObserver(() => {
    if (!current) return;
    if (!current.hasAttribute("data-tip")) hide();
    else draw();
  });

  const draw = () => {
    const el = current;
    if (!el) return;
    const text = el.getAttribute("data-tip") ?? "";
    if (!text || !el.isConnected) return hide();
    const look = lookOf(el);
    if (layer.textContent !== text) layer.textContent = text;
    layer.classList.toggle("small", look.small);
    layer.classList.toggle("wrap", look.wrap === "wrap" || look.wrap === "pre-line");
    layer.classList.toggle("clip", look.wrap === "clip");
    layer.classList.toggle("preline", look.wrap === "pre-line");
    layer.style.setProperty("--tip-max", look.max);
    const view = { width: doc.documentElement.clientWidth || win.innerWidth, height: doc.documentElement.clientHeight || win.innerHeight };
    // A one-line tip wider than the window wraps instead of running off it.
    layer.classList.remove("fit");
    if (look.wrap !== "clip" && layer.offsetWidth > view.width - TIP_MARGIN * 2) layer.classList.add("fit");
    const r = el.getBoundingClientRect();
    const at = placeTip({ left: r.left, top: r.top, width: r.width, height: r.height }, { width: layer.offsetWidth, height: layer.offsetHeight }, view, look.side);
    layer.style.left = `${Math.round(at.left)}px`;
    layer.style.top = `${Math.round(at.top)}px`;
    layer.dataset.side = at.side;
  };

  // While a tip shows it follows its element (a scroll, a layout change) and goes when the element does.
  const follow = () => {
    frame = 0;
    if (!current) return;
    if (!current.isConnected) return hide();
    draw();
    frame = win.requestAnimationFrame(follow);
  };

  const show = (el: HTMLElement, how: "hover" | "focus") => {
    if (silenced === el) return;
    if (current !== el) {
      watch.disconnect();
      current = el;
      watch.observe(el, { attributes: true, attributeFilter: ["data-tip"] });
    }
    by = how;
    draw();
    if (!current) return;
    // Shown on the next frame, so the fade (and the 2 px rise) runs from where it now sits.
    win.requestAnimationFrame(() => current === el && layer.classList.add("show"));
    if (!frame) frame = win.requestAnimationFrame(follow);
  };

  function hide() {
    current = null;
    by = null;
    watch.disconnect();
    layer.classList.remove("show");
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
  }

  const tipOf = (t: EventTarget | null): HTMLElement | null => (t instanceof win.Element ? (t.closest("[data-tip]") as HTMLElement | null) : null);

  const over = (e: MouseEvent) => {
    const el = tipOf(e.target);
    if (!el) return;
    if (el !== current || by !== "hover") show(el, "hover");
  };
  const out = (e: MouseEvent) => {
    const from = tipOf(e.target);
    const to = e.relatedTarget instanceof win.Node ? e.relatedTarget : null;
    if (from && silenced === from && !(to && from.contains(to))) silenced = null;
    if (!current || by !== "hover" || from !== current) return;
    if (to && current.contains(to) && tipOf(to) === current) return;
    // Back to a tipped element around it (a tip inside a tipped row), or nothing.
    const outer = tipOf(to);
    if (outer) show(outer, "hover");
    else if (doc.activeElement === current && current.matches(":focus-visible")) by = "focus";
    else hide();
  };
  const focusIn = (e: FocusEvent) => {
    const el = e.target instanceof win.HTMLElement && e.target.hasAttribute("data-tip") ? e.target : null;
    silenced = null;
    if (el && el.matches(":focus-visible")) show(el, "focus");
    else if (by === "focus") hide();
  };
  const focusOut = (e: FocusEvent) => {
    if (by === "focus" && e.target === current) hide();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && current) {
      silenced = current;
      hide();
    }
  };

  doc.addEventListener("mouseover", over, true);
  doc.addEventListener("mouseout", out, true);
  doc.addEventListener("focusin", focusIn, true);
  doc.addEventListener("focusout", focusOut, true);
  doc.addEventListener("keydown", key, true);
  return () => {
    hide();
    doc.removeEventListener("mouseover", over, true);
    doc.removeEventListener("mouseout", out, true);
    doc.removeEventListener("focusin", focusIn, true);
    doc.removeEventListener("focusout", focusOut, true);
    doc.removeEventListener("keydown", key, true);
    layer.remove();
  };
}
