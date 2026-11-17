import { describe, expect, test } from "bun:test";
import { EL } from "../../shared/i18n/el";
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

  test("a role is hired without a language line of its own, because every employee is given the approved one", () => {
    for (const listing of OFFICIAL_LISTINGS) {
      expect(composeInstruction(listing, null), listing.slug).not.toContain(
        "Language:",
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

/** What #127 added: Sales call and deal skills, the Legal Helper, and the Accounting close skills. */
const SALES_127 = [
  "sales-call-prep",
  "sales-call-summary",
  "sales-deal-review",
  "sales-stakeholder-map",
  "sales-forecast-narrative",
];
const ACCOUNTING_127 = [
  "accounting-close-sequence",
  "accounting-unmatched-aging",
  "accounting-flux-narrative",
];
const COUNSEL = "Draft for review by a qualified lawyer. Not legal advice.";

function listing(slug: string) {
  const found = OFFICIAL_LISTINGS.find((l) => l.slug === slug);
  if (!found) throw new Error(`No official role ${slug}`);
  return found;
}

function skillsOf(slug: string, wanted: string[]) {
  const skills = listing(slug).role.skills.filter((s) =>
    wanted.includes(s.slug),
  );
  expect(skills.map((s) => s.slug).sort()).toEqual([...wanted].sort());
  return skills;
}

describe("the roles added from the knowledge-work plugins (#127)", () => {
  test("the marketplace has 18 roles, Legal Helper among them, and Sales and Accounting carry the new skills", () => {
    expect(OFFICIAL_LISTINGS.length).toBe(18);
    expect(listing("legal-helper").title).toBe("Legal Helper");
    expect(listing("sales").version).toBe(3);
    expect(listing("accounting").version).toBe(2);
    skillsOf("sales", SALES_127);
    skillsOf("accounting", ACCOUNTING_127);
  });

  test("every text the role page shows for them has its Greek", () => {
    const legal = listing("legal-helper");
    const shown = [
      legal.title,
      legal.summary,
      legal.description,
      legal.install.roleDescription,
      ...legal.role.skills.flatMap((s) => [s.title, s.summary]),
      ...[...legal.role.connections, ...legal.role.mcpServers].map(
        (r) => r.why,
      ),
      ...skillsOf("sales", SALES_127).flatMap((s) => [s.title, s.summary]),
      ...skillsOf("accounting", ACCOUNTING_127).flatMap((s) => [
        s.title,
        s.summary,
      ]),
    ];
    expect(shown.filter((text) => !EL[text])).toEqual([]);
  });

  test("the Legal Helper is not a lawyer: it says so, and marks every output for a lawyer", () => {
    const legal = listing("legal-helper");
    const text = composeInstruction(legal, null);
    expect(text).toContain("give no legal advice: I am not a lawyer");
    expect(legal.install.roleDescription).toContain("not a lawyer");
    for (const skill of legal.role.skills) {
      expect(skill.instructions, skill.slug).toContain(COUNSEL);
    }
    expect(legal.role.outreach).toBeUndefined();
  });

  test("the playbook starts blank or from an EU, Greek or UK starter, with no US default", () => {
    const playbook = listing("legal-helper").role.skills.find(
      (s) => s.slug === "legal-playbook",
    )?.instructions as string;
    expect(playbook).toContain("blank, EU, Greek or UK");
    expect(playbook).toContain("no US default position");
    expect(playbook).toContain("to confirm with your lawyer");
    const legal = JSON.stringify(listing("legal-helper"));
    expect(legal).not.toMatch(/Delaware|New York|California|\bU\.S\./);
  });

  test("the Sales skills draft and propose, and never write to the CRM themselves", () => {
    const draftOnly: Record<string, string> = {
      "sales-call-prep": "list it for the user instead of doing it",
      "sales-call-summary":
        "You never update the CRM or send anything yourself",
      "sales-deal-review": "you never apply them",
      "sales-stakeholder-map": "for the user to add",
      "sales-forecast-narrative": "you change nothing in the CRM yourself",
    };
    for (const skill of skillsOf("sales", SALES_127)) {
      expect(skill.instructions, skill.slug).toContain(
        draftOnly[skill.slug] as string,
      );
    }
  });

  test("the close skills work from uploaded statements, with no US frameworks or products", () => {
    for (const skill of skillsOf("accounting", ACCOUNTING_127)) {
      expect(skill.instructions, skill.slug).toMatch(/upload/);
      expect(skill.instructions, skill.slug).toMatch(
        /[Cc]orrect nothing|no tax|Give no tax/,
      );
    }
    expect(everything).not.toMatch(/\bSOX\b|Sarbanes|GAAP|NetSuite/);
  });
});
