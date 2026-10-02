import { randomBytes, randomInt } from "node:crypto";

/** Short random id such as "n_k3f9x2". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex").slice(0, 6)}`;
}

/** Lower-case letters and digits, without the look-alikes 0, o, 1, l and i. */
export const PROJECT_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 8 characters from PROJECT_ID_ALPHABET, crypto-random and free of modulo bias. */
export function newProjectId(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += PROJECT_ID_ALPHABET[randomInt(PROJECT_ID_ALPHABET.length)];
  return out;
}

/** "Hero 60s!" -> "hero-60s". Falls back to "item" when nothing is left. */
export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "item";
}

/** First id from base, base-2, base-3 ... not in `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
}
