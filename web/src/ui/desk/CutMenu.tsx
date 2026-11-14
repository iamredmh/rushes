// §27, 5.2: the Cut menu. The version list (§22.8) with the lock at its foot, in place of the version button, the lock button
// and the "vN ready" chip: a cut newer than the one on screen shows as a dot on the button.
import type { Video, Version } from "../../types.js";
import { VersionMenu } from "../VersionMenu.js";

export interface CutMenuProps {
  video: Video;
  /** The cut on screen. */
  shown: Version;
  /** A cut newer than the one on screen, when there is one. */
  newer: string | null;
  onPick(id: string): void;
  onToggleLock(): void;
}

export function CutMenu({ video, shown, newer, onPick, onToggleLock }: CutMenuProps) {
  const locked = !!video.lockedVersion;
  return (
    <VersionMenu
      name="Cut"
      versions={video.versions}
      shown={shown}
      lockedVersion={video.lockedVersion}
      newer={newer}
      onPick={onPick}
      footer={(close) => (
        <button
          type="button"
          class="mi"
          disabled={!!video.shelved}
          onClick={() => {
            close(true);
            onToggleLock();
          }}
        >
          <span class="nm">{locked ? "Unlock picture" : `Lock picture at ${shown.id}`}</span>
          {locked && <span class="c">locked at {video.lockedVersion}</span>}
        </button>
      )}
    />
  );
}
