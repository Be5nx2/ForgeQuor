import { describe, expect, it } from "vitest";
import { purgeAllOffer, purgedMessage, purgeProjectOffer, removalOffer, totalArchived } from "../../web/src/projectDanger.js";

describe("the purge offers", () => {
  it("states how many Archived Runs a Project's purge deletes", () => {
    const offer = purgeProjectOffer({ name: "Slime", archivedRuns: 3 });
    expect(offer).toEqual({ disabled: false, label: "Purge its Archived Runs now", question: "Delete 3 Archived Runs of Slime now? This cannot be undone." });
  });

  it("says one Run in the singular", () => {
    expect(purgeProjectOffer({ name: "Slime", archivedRuns: 1 }).question).toContain("1 Archived Run of");
  });

  it("is disabled with 'No Archived Run' at zero", () => {
    expect(purgeProjectOffer({ name: "Slime", archivedRuns: 0 })).toEqual({ disabled: true, label: "No Archived Run", question: "" });
    expect(purgeAllOffer([])).toMatchObject({ disabled: true, label: "No Archived Run" });
  });

  it("adds up every Project for the global purge", () => {
    const projects = [{ archivedRuns: 2 }, { archivedRuns: 0 }, { archivedRuns: 5 }];
    expect(totalArchived(projects)).toBe(7);
    expect(purgeAllOffer(projects)).toEqual({ disabled: false, label: "Purge Archived Runs", question: "Delete 7 Archived Runs of every Project now? This cannot be undone." });
  });

  it("reports what a purge deleted", () => {
    expect(purgedMessage(0)).toBe("0 Archived Runs deleted.");
    expect(purgedMessage(1)).toBe("1 Archived Run deleted.");
  });
});

describe("the removal offer", () => {
  const slime = { name: "Slime Game" };

  it("enables Remove only when the typed name matches exactly", () => {
    const preview = { runs: 3, activeRuns: [] };
    expect(removalOffer(slime, preview, "").canRemove).toBe(false);
    expect(removalOffer(slime, preview, "slime game").canRemove).toBe(false);
    expect(removalOffer(slime, preview, "Slime Game ").canRemove).toBe(false);
    expect(removalOffer(slime, preview, "Slime Game").canRemove).toBe(true);
  });

  it("states how many Runs will be deleted", () => {
    expect(removalOffer(slime, { runs: 3, activeRuns: [] }, "").runsText).toContain("deletes 3 Runs of Slime Game");
    expect(removalOffer(slime, { runs: 1, activeRuns: [] }, "").runsText).toContain("deletes 1 Run of");
    expect(removalOffer(slime, { runs: 0, activeRuns: [] }, "").runsText).toContain("has no Run");
  });

  it("is blocked, even with the right name, while a Run is active, and says which", () => {
    const active = [
      { id: 7, title: "Add jump", state: "approved", prNumber: 12 },
      { id: 8, title: "Fix", state: "queued", prNumber: null },
    ];
    const offer = removalOffer(slime, { runs: 2, activeRuns: active }, "Slime Game");
    expect(offer.canRemove).toBe(false);
    expect(offer.blockedBy).toEqual(['Run 7 "Add jump" is approved (pull request #12)', 'Run 8 "Fix" is queued']);
  });
});
