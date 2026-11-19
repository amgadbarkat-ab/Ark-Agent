/**
 * What each role may do. Checked on the server for every request; a page's links follow the same
 * table, but hiding a link is never the check.
 *
 * | | owner | admin | support | read-only |
 * |---|---|---|---|---|
 * | Overview, Customers, Services, Issues | yes | yes | yes | yes |
 * | Cases: read | yes | yes | yes | yes |
 * | Cases: open, change, add a note | yes | yes | yes | no |
 * | Audit log | yes | yes | no | no |
 * | Accounts: add, disable, reset support and read-only | yes | yes | no | no |
 * | Accounts: add, disable, reset owner and admin | yes | no | no | no |
 */
import type { Role } from "./store";

export type Permission =
  | "view"
  | "cases.read"
  | "cases.write"
  | "audit.read"
  | "accounts.manage";

const TABLE: Record<Role, readonly Permission[]> = {
  owner: ["view", "cases.read", "cases.write", "audit.read", "accounts.manage"],
  admin: ["view", "cases.read", "cases.write", "audit.read", "accounts.manage"],
  support: ["view", "cases.read", "cases.write"],
  "read-only": ["view", "cases.read"],
};

export function can(role: Role, permission: Permission): boolean {
  return TABLE[role].includes(permission);
}

/** Whether `actor` may add, disable or reset an account with role `target`. */
export function canManage(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target === "support" || target === "read-only";
  return false;
}
