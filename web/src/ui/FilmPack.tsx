// §26.6: the Films pack across the top. Only films in play are pills, and pills only switch films. Those past how many the
// window shows fold into a +N list (the film you are on is always a pill), and shelved films live under a Shelved (N) button at the end. Also the
// banner a shelved film opens under, and the empty state when every film is shelved.
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { inPlay, maxPills, packShown, shownFilms } from "../lib.js";
import type { Video } from "../types.js";
import { Icon } from "./Icon.js";
import { useDismiss } from "./useDismiss.js";

export interface FilmPackProps {
  /** Every film, in the project's order. */
  films: Video[];
  currentId: string | null;
  /** The header the pack sits in: its width sets how many pills show. */
  headRef: RefObject<HTMLElement>;
  hasTodo(id: string): boolean;
  /** Open a film (a pill, a row of +N, or a shelved film from the Shelved list). */
  onSwitch(id: string): void;
  onRestore(id: string): void;
  /** Counts up each time something asks for the Shelved list to open (the empty state's button). */
  shelvedRequest: number;
}

/** "13 Oct". */
export const shortDate = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * The pack and the Shelved button, as two children of the header (the header's own layout rules, which let the films' names give
 * way to each other, apply to the pack as a direct child).
 */
export function FilmPack({ films, currentId, headRef, hasTodo, onSwitch, onRestore, shelvedRequest }: FilmPackProps) {
  const live = films.filter(inPlay);
  const shelved = films.filter((f) => !inPlay(f));
  const multi = packShown(films, currentId);
  const [menu, setMenu] = useState<"more" | "shelved" | null>(null);
  const [headWidth, setHeadWidth] = useState(() => headRef.current?.clientWidth ?? 1440);
  const moreButton = useRef<HTMLButtonElement>(null);
  const shelfButton = useRef<HTMLButtonElement>(null);
  const moreWrap = useRef<HTMLSpanElement>(null);
  const shelfWrap = useRef<HTMLSpanElement>(null);

  // The header's width, and only that: how many pills show follows the window, never the layout the pills sit in.
  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const read = () => setHeadWidth(head.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);

  const close = (focusButton: boolean) => {
    const was = menu;
    setMenu(null);
    if (focusButton) (was === "more" ? moreButton : shelfButton).current?.focus();
  };
  // Either list closes on a click or focus outside it, and on Escape.
  const open = menu === "more" ? moreWrap : shelfWrap;
  useDismiss(menu !== null, open, close);
  useEffect(() => {
    if (shelvedRequest > 0) setMenu("shelved");
  }, [shelvedRequest]);
  // A list with nothing left to show closes itself.
  useEffect(() => {
    if ((menu === "shelved" && shelved.length === 0) || (menu === "more" && !multi)) setMenu(null);
  }, [menu, shelved.length, multi]);

  const indices = shownFilms(live.length, live.findIndex((f) => f.id === currentId), maxPills(headWidth));
  const pills = indices.map((i) => live[i]);
  const folded = live.filter((_, i) => !indices.includes(i));
  const pill = (f: Video, n: number) => (
    <button type="button" class="pill" aria-pressed={f.id === currentId} onClick={() => onSwitch(f.id)}>
      <span class="n">{n}</span>
      <span class="pname">{f.name}</span>
      {hasTodo(f.id) && <span class="dot" />}
    </button>
  );

  return (
    <>
      {multi && (
        <nav class="pack" aria-label="Films">
          {pills.map((f) => pill(f, live.indexOf(f) + 1))}
          {folded.length > 0 && (
            <span class="fpwrap" ref={moreWrap}>
              <button
                ref={moreButton}
                type="button"
                class="pill fpmore"
                aria-label={`${folded.length} more films`}
                aria-haspopup="true"
                aria-expanded={menu === "more"}
                onClick={() => setMenu(menu === "more" ? null : "more")}
              >
                +{folded.length}
                {folded.some((f) => hasTodo(f.id)) && <span class="dot" />}
                <Icon name="chev" />
              </button>
              {menu === "more" && (
                <div class="fpmenu" role="group" aria-label="More films">
                  {folded.map((f) => (
                    <button
                      type="button"
                      class="fprow"
                      onClick={() => {
                        setMenu(null);
                        onSwitch(f.id);
                      }}
                    >
                      <span class="n">{live.indexOf(f) + 1}</span>
                      <span class="pname" dir="auto">{f.name}</span>
                      {hasTodo(f.id) && <span class="dot" />}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
        </nav>
      )}
      {shelved.length > 0 && (
        <span class="fpwrap fpshelfwrap" ref={shelfWrap}>
          <button
            ref={shelfButton}
            type="button"
            class={`fpshelf${shelved.some((f) => f.id === currentId) ? " on" : ""}`}
            aria-haspopup="true"
            aria-expanded={menu === "shelved"}
            onClick={() => setMenu(menu === "shelved" ? null : "shelved")}
          >
            <Icon name="shelve" />
            Shelved ({shelved.length})
          </button>
          {menu === "shelved" && (
            <div class="fpmenu" role="group" aria-label="Shelved films">
              <h4>Shelved</h4>
              {shelved.map((f) => (
                <div class="fprow shelved">
                  <button
                    type="button"
                    class="fpopen"
                    aria-label={`Open ${f.name}`}
                    onClick={() => {
                      setMenu(null);
                      onSwitch(f.id);
                    }}
                  >
                    <span class="pname" dir="auto">{f.name}</span>
                    <span class="meta">{f.versions.length} {f.versions.length === 1 ? "cut" : "cuts"} · {shortDate(f.shelved!)}</span>
                  </button>
                  <button
                    type="button"
                    class="btn ghost ib fprestore"
                    aria-label={`Restore ${f.name}`}
                    data-tip="Restore film"
                    onClick={() => {
                      setMenu(null);
                      onRestore(f.id);
                    }}
                  >
                    <Icon name="undo" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </span>
      )}
    </>
  );
}

/** §26.6: what a shelved film opens under: when it was shelved, that it is view only, and a way back. */
export function ShelvedBanner({ video, onRestore }: { video: Video; onRestore(): void }) {
  return (
    <div class="shbanner" role="region" aria-label="Shelved film">
      <Icon name="shelve" />
      <span class="shtext">
        Shelved <b dir="auto">{video.name}</b> on {shortDate(video.shelved!)}. View only.
      </span>
      <span class="sp" />
      <button type="button" class="btn" onClick={onRestore}>
        <Icon name="undo" />
        Restore film
      </button>
    </div>
  );
}

/** §26.6: Picture with every film shelved. */
export function AllShelved({ onOpen }: { onOpen(): void }) {
  return (
    <div class="empty shempty">
      <p><b>All films are shelved</b></p>
      <p>Nothing is in play. Restore a film to carry on.</p>
      <button type="button" class="btn" onClick={onOpen}>Open the Shelved list</button>
    </div>
  );
}
