// The plan's approvals, one rule for all three pages: the brief, each script section and each storyboard shot.
// Pure (no Node imports). The user approves; an approval is for the words they read, so a change to the words of
// an approved item reopens it (back to draft), whoever makes it. On the agent's side that is setSections (script)
// and the agent rewriting brief.md or storyboard.md; on the user's, an edit in the dashboard, below.
//
// Prior art: GitHub's "dismiss stale pull request approvals when new commits are pushed".

/**
 * The status an item has after the user's edit. A change to an approved item's words (or direction) reopens it,
 * unless the same edit sets the status; a save that changes no words, and an item that isn't approved, keep theirs.
 */
export function statusAfterEdit<S extends string>(was: S | "approved", edit: { wordsChanged: boolean; status?: S | "approved" | "draft" }): S | "approved" | "draft" {
  if (edit.status !== undefined) return edit.status;
  return was === "approved" && edit.wordsChanged ? "draft" : was;
}
