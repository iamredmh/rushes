// Light or dark (§27, 5.10). Dark is the default: it is the ground for judging picture. The setting
// is the browser's own (localStorage), never the project's. A browser that refuses storage opens dark.

export type ThemeSetting = "dark" | "light" | "system";
export type Theme = "dark" | "light";

export const THEME_KEY = "rushes:theme";
/** Fired on `window` after the page's theme changes, for anything drawn in script (the lanes' waveforms). */
export const THEME_EVENT = "rushes:theme";

const SETTINGS: readonly ThemeSetting[] = ["dark", "light", "system"];

/** The saved setting, or dark: for no storage, a storage that throws (a private window), or a value it never wrote. */
export function readTheme(storage: Pick<Storage, "getItem"> | null): ThemeSetting {
  try {
    const v = storage?.getItem(THEME_KEY);
    return SETTINGS.includes(v as ThemeSetting) ? (v as ThemeSetting) : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(setting: ThemeSetting, systemDark: boolean): Theme {
  if (setting === "system") return systemDark ? "dark" : "light";
  return setting;
}

/** Dark, light, match the system, and round again. */
export function nextTheme(setting: ThemeSetting): ThemeSetting {
  return SETTINGS[(SETTINGS.indexOf(setting) + 1) % SETTINGS.length];
}

export const THEME_LABEL: Record<ThemeSetting, string> = { dark: "Dark", light: "Light", system: "Match the system" };

/** The browser's storage, or null where even asking for it throws. */
export function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Never throws: a setting that cannot be kept still applies until the page closes. */
export function saveTheme(setting: ThemeSetting): void {
  try {
    safeStorage()?.setItem(THEME_KEY, setting);
  } catch {
    // Kept for this page only.
  }
}

let unfollow: (() => void) | null = null;

/** Puts the theme on the page, and for "system" keeps following the machine. */
export function applyTheme(setting: ThemeSetting): void {
  unfollow?.();
  unfollow = null;
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const set = () => {
    const theme = resolveTheme(setting, media ? media.matches : true);
    if (document.documentElement.dataset.theme === theme) return;
    document.documentElement.dataset.theme = theme;
    window.dispatchEvent(new Event(THEME_EVENT));
  };
  set();
  if (setting === "system" && media) {
    media.addEventListener("change", set);
    unfollow = () => media.removeEventListener("change", set);
  }
}

/** A colour token's value as the page has it now, for a canvas, which cannot read `var()`. */
export function tokenColor(el: Element, value: string): string {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  if (!m) return value;
  return getComputedStyle(el).getPropertyValue(m[1]).trim() || value;
}
