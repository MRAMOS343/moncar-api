// src/middleware/auth.ts
import { requireAnyRole, type UserRole } from "./requireAnyRole";

export { requireAuth } from "./requireAuth";
export type { UserRole } from "./requireAnyRole";

/**
 * Backward-compatible: requireRole("admin")
 * Internamente usa requireAnyRole(["admin"])
 */
export function requireRole(role: UserRole) {
  return requireAnyRole([role]);
}
