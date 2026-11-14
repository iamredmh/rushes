// §27, 5.2: the Film menu. One button naming the film you are in; its menu lists the films in play by number and full name
// with their open notes, and the shelved films in a group at the foot, each with Restore. It replaces the film pills, the +N
// list and the Shelved button (§26.6). One film in play and none shelved: the film's name, plain, with no menu.
import { shortDate } from "../../desk.js";
import { useEffect } from "preact/hooks";
import { inPlay } from "../../lib.js";
import { typeAhead } from "../../versions.js";
import type { Video } from "../../types.js";
import { Icon } from "../Icon.js";
import { useMenu } from "./useMenu.js";

export interface FilmSelectProps {
  /** Every film, in the project's order. */
  films: Video[];
  currentId: string | null;
  /** The film's open (to-do) notes. */
  openNotes(id: string): number;
  onSwitch(id: string): void;
  onRestore(id: string): void;
  /** Counts up each time something asks for the menu to open on its Shelved group (the all-shelved page's button). */
  shelvedRequest: number;
}

export function FilmSelect({ films, currentId, openNotes, onSwitch, onRestore, shelvedRequest }: FilmSelectProps) {
  const live = films.filter(inPlay);
  const shelved = films.filter((f) => !inPlay(f));
  const current = films.find((f) => f.id === currentId);
  // The rows the arrows move through: each film in play, then each shelved film's Open and Restore.
  const count = live.length + shelved.length * 2;
  const menu = useMenu(count, (text) => {
    if (/^\d+$/.test(text)) {
      const hit = typeAhead(live.map((_, i) => String(i + 1)), text);
      return hit === null ? null : Number(hit) - 1;
    }
    const i = live.findIndex((f) => f.name.toLowerCase().startsWith(text));
    if (i >= 0) return i;
    const j = shelved.findIndex((f) => f.name.toLowerCase().startsWith(text));
    return j >= 0 ? live.length + j * 2 : null;
  });
  useEffect(() => {
    if (shelvedRequest > 0 && shelved.length > 0) menu.show(live.length);
  }, [shelvedRequest]);

  if (live.length <= 1 && shelved.length === 0) {
    return (
      <span class="filmsel plain" data-tip={current?.name}>
        <small>Film</small>
        <span class="filmname" dir="auto">{current?.name ?? "No film yet"}</span>
      </span>
    );
  }
  const pick = (f: Video) => {
    menu.close(true);
    onSwitch(f.id);
  };
  const status = (f: Video) => {
    if (f.versions.length === 0) return "no cut yet";
    const n = openNotes(f.id);
    return n > 0 ? `${n} open` : "done";
  };
  return (
    <span class="filmsel mwrap" ref={menu.wrap}>
      <button
        ref={menu.button}
        type="button"
        class="pick"
        aria-label={`Film: ${current?.name ?? "none open"}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => menu.toggle(Math.max(0, live.findIndex((f) => f.id === currentId)))}
        onKeyDown={(e) => {
          if (!menu.open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            e.stopPropagation();
            menu.show(Math.max(0, live.findIndex((f) => f.id === currentId)));
          }
        }}
      >
        <small>Film</small>
        <span class="filmname" dir="auto">{current?.name ?? "None open"}</span>
        {current?.shelved && <span class="fshelved">shelved</span>}
        <Icon name="chev" />
      </button>
      {menu.open && (
        <div class="dmenu films" role="menu" aria-label="Films" onKeyDown={menu.onKeyDown}>
          {live.map((f, i) => (
            <button
              key={f.id}
              ref={menu.row(i)}
              type="button"
              role="menuitem"
              class="mi"
              tabIndex={-1}
              aria-current={f.id === currentId ? "true" : undefined}
              onClick={() => pick(f)}
            >
              <span class="k">{i + 1}</span>
              <span class="nm" dir="auto">{f.name}</span>
              <span class={`c${openNotes(f.id) > 0 ? " todo" : ""}`}>{status(f)}</span>
            </button>
          ))}
          {shelved.length > 0 && (
            <>
              <hr />
              <div class="hd">Shelved ({shelved.length})</div>
              {shelved.map((f, j) => (
                <div class="mrow" key={f.id}>
                  <button
                    ref={menu.row(live.length + j * 2)}
                    type="button"
                    role="menuitem"
                    class="mi"
                    tabIndex={-1}
                    aria-label={`Open ${f.name}`}
                    aria-current={f.id === currentId ? "true" : undefined}
                    onClick={() => pick(f)}
                  >
                    <span class="k" />
                    <span class="nm" dir="auto">{f.name}</span>
                    <span class="c">{f.versions.length} {f.versions.length === 1 ? "cut" : "cuts"} · {shortDate(f.shelved!)}</span>
                  </button>
                  <button
                    ref={menu.row(live.length + j * 2 + 1)}
                    type="button"
                    role="menuitem"
                    class="ibtn"
                    tabIndex={-1}
                    aria-label={`Restore ${f.name}`}
                    data-tip={`Restore ${f.name}`}
                    onClick={() => {
                      menu.close(true);
                      onRestore(f.id);
                    }}
                  >
                    <Icon name="undo" />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </span>
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

/** §26.6: Review with every film shelved. */
export function AllShelved({ onOpen }: { onOpen(): void }) {
  return (
    <div class="empty shempty">
      <p><b>All films are shelved</b></p>
      <p>Nothing is in play. Restore a film to carry on.</p>
      <button type="button" class="btn" onClick={onOpen}>Open the Shelved list</button>
    </div>
  );
}
