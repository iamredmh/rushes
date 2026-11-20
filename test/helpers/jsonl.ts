/**
 * Reads the fake agent's JSONL log. The fake appends while a test reads, so the last line may be half written: a line
 * that doesn't parse is left out (it is read whole on the next poll), never thrown on (CI run 44734944658).
 */
export function readJsonl(text: string): any[] {
  const out: any[] = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // A line still being written.
    }
  }
  return out;
}
