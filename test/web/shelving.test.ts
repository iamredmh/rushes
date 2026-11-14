import { describe, expect, it } from "vitest";
import { filmAfterShelving, inPlay, neighbourVideo } from "../../web/src/lib.js";
import type { Video } from "../../web/src/types.js";

// §26.6: which film comes next, how [ and ] step, and how many pills fit the bar.
const film = (id: string, shelved?: string): Video => ({ id, name: id, versions: [], lockedVersion: null, ...(shelved ? { shelved } : {}) });
const SHELVED = "2026-10-13T10:00:00.000Z";

describe("inPlay", () => {
  it("is false only for a film with a shelved time", () => {
    expect(inPlay(film("a"))).toBe(true);
    expect(inPlay({ ...film("a"), shelved: null })).toBe(true);
    expect(inPlay(film("a", SHELVED))).toBe(false);
  });
});

describe("neighbourVideo (the [ and ] keys) skips shelved films", () => {
  const films = [film("a"), film("b", SHELVED), film("c"), film("d", SHELVED), film("e")];
  it("steps through the films in play", () => {
    expect(neighbourVideo(films, "a", 1)).toBe("c");
    expect(neighbourVideo(films, "c", 1)).toBe("e");
    expect(neighbourVideo(films, "c", -1)).toBe("a");
    expect(neighbourVideo(films, "e", -1)).toBe("c");
  });
  it("stops at either end, as it always did", () => {
    expect(neighbourVideo(films, "a", -1)).toBeNull();
    expect(neighbourVideo(films, "e", 1)).toBeNull();
  });
  it("from a shelved film goes to the nearest film in play before or after it", () => {
    expect(neighbourVideo(films, "b", 1)).toBe("c");
    expect(neighbourVideo(films, "b", -1)).toBe("a");
    expect(neighbourVideo(films, "d", 1)).toBe("e");
    expect(neighbourVideo([film("x", SHELVED), film("y")], "x", -1)).toBeNull();
  });
  it("is null for a film that is not there, and when nothing is in play", () => {
    expect(neighbourVideo(films, "nope", 1)).toBeNull();
    expect(neighbourVideo([film("a", SHELVED)], "a", 1)).toBeNull();
  });
  it("is unchanged when nothing is shelved", () => {
    const plain = [film("a"), film("b"), film("c")];
    expect(neighbourVideo(plain, "b", 1)).toBe("c");
    expect(neighbourVideo(plain, "b", -1)).toBe("a");
  });
});

describe("filmAfterShelving: where you land when the film you are on is shelved", () => {
  it("is the next film in play to its right, else the one to its left", () => {
    const films = [film("a"), film("b"), film("c", SHELVED), film("d")];
    expect(filmAfterShelving(films, "b")).toBe("d");
    expect(filmAfterShelving(films, "d")).toBe("b");
    expect(filmAfterShelving([film("a"), film("b")], "a")).toBe("b");
  });
  it("is null when there is no other film in play", () => {
    expect(filmAfterShelving([film("a")], "a")).toBeNull();
    expect(filmAfterShelving([film("a"), film("b", SHELVED)], "a")).toBeNull();
  });
});
