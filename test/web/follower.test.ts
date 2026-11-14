// §27, 5.6: on the Timeline tab the video is the clock and the audio engine follows it. `followerAction` is the one
// decision `useFollower` applies on each of the video's events.
import { describe, expect, it } from "vitest";
import { followerAction, STREAM_DRIFT_SECONDS } from "../../web/src/audio/timeline.js";

describe("followerAction", () => {
  it("does nothing when both are stopped and in step", () => {
    expect(followerAction(3, 3, false, false)).toBeNull();
  });
  it("starts the engine when the video plays and the engine is stopped", () => {
    expect(followerAction(3, 3, true, false)).toBe("play");
  });
  it("stops the engine when the video pauses and the engine plays", () => {
    expect(followerAction(3, 3, false, true)).toBe("pause");
  });
  it("re-seats the engine when both play 0.2 s apart", () => {
    expect(followerAction(3.2, 3, true, true)).toBe("seek");
    expect(followerAction(3, 3.2, true, true)).toBe("seek");
  });
  it("leaves the engine alone when both play 0.02 s apart", () => {
    expect(followerAction(3.02, 3, true, true)).toBeNull();
  });
  it("moves a stopped engine to a stopped video 1 s away", () => {
    expect(followerAction(4, 3, false, false)).toBe("seek");
  });
  it("starts or stops before it seeks: a play or a pause also puts the engine where the video is", () => {
    expect(followerAction(9, 3, true, false)).toBe("play");
    expect(followerAction(9, 3, false, true)).toBe("pause");
  });
  it("tolerates exactly the drift allowance", () => {
    expect(followerAction(3 + STREAM_DRIFT_SECONDS, 3, true, true)).toBeNull();
  });
});
