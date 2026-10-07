// The version list's day logic across a clock change (M3). Runs in a zone with summer time whatever
// the machine's own zone is (CI is UTC, which has none): Node picks up a TZ set at run time.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ago, dayDiff } from "../../web/src/versions.js";

const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = "Europe/London"; });
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe("calendar days across a clock change (Europe/London)", () => {
  it("the zone really changes its clocks on these days", () => {
    expect(new Date(2026, 2, 29, 0, 30).getTimezoneOffset()).toBe(0); // GMT
    expect(new Date(2026, 2, 29, 3, 0).getTimezoneOffset()).toBe(-60); // BST
  });
  it("the spring day is 23 hours long and still one day", () => {
    // 00:15 on 29 Mar to 00:30 on 30 Mar is 23 h 15 min of elapsed time.
    expect(dayDiff(new Date(2026, 2, 29, 0, 15).toISOString(), new Date(2026, 2, 30, 0, 30))).toBe(1);
    expect(ago(new Date(2026, 2, 29, 0, 15).toISOString(), new Date(2026, 2, 30, 0, 30))).toBe("yesterday");
    expect(dayDiff(new Date(2026, 2, 29, 23, 0).toISOString(), new Date(2026, 2, 29, 23, 30))).toBe(0);
  });
  it("the autumn day is 25 hours long and still one day", () => {
    // 23:30 on 24 Oct to 23:45 on 25 Oct is 25 h 15 min of elapsed time.
    expect(dayDiff(new Date(2026, 9, 24, 23, 30).toISOString(), new Date(2026, 9, 25, 23, 45))).toBe(1);
    expect(ago(new Date(2026, 9, 24, 23, 30).toISOString(), new Date(2026, 9, 25, 23, 45))).toBe("yesterday");
    // 00:10 to 23:50 on 25 Oct is 24 h 40 min, all on one day: hours, not "yesterday".
    expect(dayDiff(new Date(2026, 9, 25, 0, 10).toISOString(), new Date(2026, 9, 25, 23, 50))).toBe(0);
    expect(ago(new Date(2026, 9, 25, 0, 10).toISOString(), new Date(2026, 9, 25, 23, 50))).toBe("24 h ago");
    expect(dayDiff(new Date(2026, 9, 20, 12).toISOString(), new Date(2026, 9, 27, 11))).toBe(7);
  });
});
