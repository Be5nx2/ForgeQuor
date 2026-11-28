import { describe, expect, it } from "vitest";
import { purgeAllOffer, purgedMessage, purgeProjectOffer, totalArchived } from "../../web/src/projectDanger.js";

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
