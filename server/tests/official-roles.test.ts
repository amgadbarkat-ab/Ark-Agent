import { describe, expect, test } from "bun:test";
import { CATEGORIES, LIMITS } from "../../shared/marketplace";
import {
  composeInstruction,
  OFFICIAL_LISTINGS,
} from "../src/marketplace/official";

const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const everything = JSON.stringify(OFFICIAL_LISTINGS);

describe("Ark's digital employees", () => {
  test("have unique addresses and titles, and fit the limits a listing has", () => {
    const slugs = OFFICIAL_LISTINGS.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(OFFICIAL_LISTINGS.map((l) => l.title)).size).toBe(
      slugs.length,
    );
    for (const listing of OFFICIAL_LISTINGS) {
      expect(listing.slug).toMatch(SLUG);
      expect(listing.title.length).toBeLessThanOrEqual(LIMITS.title);
      expect(listing.summary.length).toBeLessThanOrEqual(LIMITS.summary);
      expect(listing.description.length).toBeLessThanOrEqual(
        LIMITS.description,
      );
      expect(listing.tags.length).toBeLessThanOrEqual(LIMITS.tags);
      for (const tag of listing.tags) {
        expect(tag.length).toBeLessThanOrEqual(LIMITS.tagLength);
      }
      expect(CATEGORIES.some((c) => c.id === listing.category)).toBe(true);
      expect(listing.install.roleDescription.length).toBeLessThanOrEqual(600);
    }
  });

  test("each one has a persona, skills that can be added, and what it will ask to be connected", () => {
    for (const { slug, role } of OFFICIAL_LISTINGS) {
      expect(role.iam, slug).not.toBe("");
      for (const list of [
        role.duties,
        role.worksWith,
        role.supportedBy,
        role.canDo,
      ]) {
        expect(list.length, slug).toBeGreaterThanOrEqual(2);
      }
      expect(role.skills.length, slug).toBeGreaterThanOrEqual(2);
      expect(role.connections.length, slug).toBeGreaterThanOrEqual(1);
      expect(role.mcpServers.length, slug).toBeGreaterThanOrEqual(1);
      for (const skill of role.skills) {
        expect(skill.slug, slug).toMatch(SLUG);
        expect(skill.title.trim(), skill.slug).not.toBe("");
        expect(skill.instructions.length, skill.slug).toBeGreaterThan(200);
      }
      for (const request of [...role.connections, ...role.mcpServers]) {
        expect(request.why.length, slug).toBeGreaterThan(5);
      }
    }
  });

  test("no skill name is used twice, so installing every role never makes one overwrite another", () => {
    const skills = OFFICIAL_LISTINGS.flatMap((l) =>
      l.role.skills.map((s) => s.slug),
    );
    expect(new Set(skills).size).toBe(skills.length);
  });

  test("the product says digital employee, never bot", () => {
    expect(everything.toLowerCase()).not.toMatch(/\bbots?\b/);
  });

  test("the instruction speaks as the role, says what it cannot do, and ends with the honesty rule", () => {
    for (const listing of OFFICIAL_LISTINGS) {
      const text = composeInstruction(listing, "Acme Ltd");
      expect(text).toContain(`You are ${listing.title} at Acme Ltd`);
      expect(text).toContain("first person");
      expect(text).toContain("never pretend I used it");
      expect(text).toContain("I never claim to have contacted anyone");
      expect(
        text.endsWith(
          "Ask before doing anything that changes something outside this conversation.",
        ),
      ).toBe(true);
      expect(text.length).toBeLessThan(6000);
      expect(composeInstruction(listing, null)).not.toContain(" at null");
    }
  });

  test("every role works in Greek, English and Arabic and keeps names and figures exact", () => {
    for (const listing of OFFICIAL_LISTINGS) {
      const text = composeInstruction(listing, null);
      expect(text, listing.slug).toContain("Greek, English and Arabic");
      expect(text, listing.slug).toContain(
        "names, numbers, dates and legal terms",
      );
    }
  });

  test("a role that writes to people outside the company drafts only and ends with the approved opt-out line", () => {
    const outreach = OFFICIAL_LISTINGS.filter((l) => l.role.outreach).map(
      (l) => l.slug,
    );
    expect(outreach.sort()).toEqual(["marketing", "sales"]);
    for (const listing of OFFICIAL_LISTINGS) {
      const text = composeInstruction(listing, null);
      if (listing.role.outreach) {
        expect(text).toContain("you only write drafts");
        expect(text).toContain(
          "Αν δεν επιθυμείτε να λαμβάνετε άλλα μηνύματα, απαντήστε «ΔΙΑΓΡΑΦΗ».",
        );
        expect(text).toContain("If you'd rather not hear from us again");
        // No Arabic wording has been approved, so the instruction says to ask for it.
        expect(text).toContain("no approved Arabic line");
      } else {
        expect(text).not.toContain("Outreach rules");
      }
    }
  });
});
