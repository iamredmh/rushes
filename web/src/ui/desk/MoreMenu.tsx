// §27, 5.2: the More menu, the top bar's last control. What is not about one place on the desk: bringing in the files found,
// Export notes, shelving the film you are in, the Proxies tab (§36), the keyboard shortcuts and Appearance. It takes in
// what the old film-actions menu held (§26.6).
import { useState } from "preact/hooks";
import { api } from "../../api.js";
import { applyTheme, nextTheme, readTheme, safeStorage, saveTheme, THEME_LABEL } from "../../theme.js";
import type { Video } from "../../types.js";
import { Icon } from "../Icon.js";
import { useMenu } from "./useMenu.js";

export interface MoreMenuProps {
  /** What the folder holds that is not in Rushes yet ("3 brought in · 118 more found"), or null. */
  found: string | null;
  onBringIn(): void;
  video: Video | undefined;
  onToggleShelved(): void;
  /** §36.7: opens the notes panel on its Proxies tab, where proxies are set up (replaces §19.5's autoProxy row). */
  onProxies(): void;
  onKeys(): void;
  toast(message: string): void;
  onChanged(): void;
}

export function MoreMenu({ found, onBringIn, video, onToggleShelved, onProxies, onKeys, toast, onChanged }: MoreMenuProps) {
  const menu = useMenu(6);
  const shelved = !!video?.shelved;
  // The browser's own setting, not the film's.
  const [theme, setTheme] = useState(() => readTheme(safeStorage()));
  const cycleTheme = () => {
    const next = nextTheme(theme);
    saveTheme(next);
    applyTheme(next);
    setTheme(next);
  };
  const exportNotes = async () => {
    try {
      const { path } = await api.post<{ path: string }>("/api/exports/notes");
      toast(`Saved to ${path}`);
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  /** A row that does its thing and closes the menu. */
  const act = (run: () => void) => () => {
    menu.close(true);
    run();
  };

  return (
    <span class="mwrap more" ref={menu.wrap}>
      <button
        ref={menu.button}
        type="button"
        class="ibtn"
        aria-label="More"
        data-tip="More"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => menu.toggle(0)}
      >
        <Icon name="more" />
      </button>
      {menu.open && (
        <div class="dmenu" role="menu" aria-label="More" onKeyDown={menu.onKeyDown}>
          <button ref={menu.row(0)} type="button" role="menuitem" class="mi" tabIndex={-1} onClick={act(onBringIn)}>
            <Icon name="download" />
            <span class="nm">Bring in new files</span>
            {found && <span class="c">{found}</span>}
          </button>
          <button ref={menu.row(1)} type="button" role="menuitem" class="mi" tabIndex={-1} onClick={act(() => void exportNotes())}>
            <Icon name="save" />
            <span class="nm">Export notes</span>
          </button>
          <hr />
          <button ref={menu.row(2)} type="button" role="menuitem" class="mi" tabIndex={-1} disabled={!video} onClick={act(onToggleShelved)}>
            <Icon name={shelved ? "undo" : "shelve"} />
            <span class="nm">{shelved ? "Restore film" : "Shelve film"}</span>
            {video && <span class="c fn" dir="auto">{video.name}</span>}
            <kbd>Shift+S</kbd>
          </button>
          <button ref={menu.row(3)} type="button" role="menuitem" class="mi" tabIndex={-1} onClick={act(onProxies)}>
            <Icon name="zap" />
            <span class="nm">Proxies</span>
          </button>
          <hr />
          <button ref={menu.row(4)} type="button" role="menuitem" class="mi" tabIndex={-1} onClick={act(onKeys)}>
            <Icon name="kbd" />
            <span class="nm">Keyboard shortcuts</span>
            <kbd>?</kbd>
          </button>
          {/* Stays open, so one more press tries the next setting. */}
          <button ref={menu.row(5)} type="button" role="menuitem" class="mi" tabIndex={-1} onClick={cycleTheme}>
            <Icon name="circle" />
            <span class="nm">Appearance: {THEME_LABEL[theme]}</span>
          </button>
        </div>
      )}
    </span>
  );
}
