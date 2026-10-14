import { describe, expect, it } from "vitest";
import { filmAfterShelving, inPlay, maxPills, neighbourVideo, packShown, shownFilms } from "../../web/src/lib.js";
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

describe("maxPills: how many pills the bar shows before the rest fold into +N", () => {
  it("is about one film for every 190 px of header", () => {
    expect(maxPills(1360)).toBe(7);
    expect(maxPills(1100)).toBe(5);
    expect(maxPills(1900)).toBe(10);
  });
  it("is also no more than the room the pack has once the rest of the header is at its smallest: each pill squeezed to its number, and the +N button", () => {
    expect(maxPills(1360, 600)).toBe(7);
    expect(maxPills(1360, 200)).toBe(5);
    expect(maxPills(1360, 150)).toBe(3);
    expect(maxPills(1360, 100)).toBe(2);
    expect(maxPills(1360, 0)).toBe(2);
    expect(maxPills(1360, undefined)).toBe(7);
  });
  it("is never fewer than three or more than twelve", () => {
    expect(maxPills(400)).toBe(3);
    expect(maxPills(0)).toBe(3);
    expect(maxPills(5000)).toBe(12);
  });
});

describe("shownFilms: which films in play are pills", () => {
  it("is every film when they fit", () => {
    expect(shownFilms(4, 0, 7)).toEqual([0, 1, 2, 3]);
    expect(shownFilms(7, 6, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(shownFilms(0, -1, 7)).toEqual([]);
  });
  it("is the first few when they do not, and the rest are folded", () => {
    expect(shownFilms(10, 0, 4)).toEqual([0, 1, 2, 3]);
    expect(shownFilms(10, 3, 4)).toEqual([0, 1, 2, 3]);
  });
  it("always keeps the film you are on as a pill, in place of the last of those", () => {
    expect(shownFilms(10, 8, 4)).toEqual([0, 1, 2, 8]);
    expect(shownFilms(10, 4, 4)).toEqual([0, 1, 2, 4]);
    expect(shownFilms(10, 9, 3)).toEqual([0, 1, 9]);
  });
  it("shows the first few when no film is current", () => {
    expect(shownFilms(10, -1, 4)).toEqual([0, 1, 2, 3]);
  });
});

describe("packShown: when the bar shows pills at all", () => {
  it("needs two films in play, as it needed two films before", () => {
    expect(packShown([film("a")], "a")).toBe(false);
    expect(packShown([film("a"), film("b")], "a")).toBe(true);
    expect(packShown([film("a"), film("b", SHELVED), film("c", SHELVED)], "a")).toBe(false);
    expect(packShown([], null)).toBe(false);
  });
  it("shows the one film in play when you are looking at a shelved film, so there is a way back", () => {
    expect(packShown([film("a"), film("b", SHELVED)], "b")).toBe(true);
    expect(packShown([film("a", SHELVED), film("b", SHELVED)], "a")).toBe(false);
  });
});
