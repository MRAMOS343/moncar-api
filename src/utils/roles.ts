// src/utils/roles.ts

export const ROLES = ["admin", "gerente", "vendedor", "user"] as const;
export type UserRole = (typeof ROLES)[number];

/**
 * Verifica si un rol es válido.
 */
export function isValidRole(role: unknown): role is UserRole {
  return typeof role === "string" && ROLES.includes(role as UserRole);
}

/**
 * Jerarquía de roles (mayor número = más permisos).
 */
export const ROLE_HIERARCHY: Record<UserRole, number> = {
  admin: 100,
  gerente: 50,
  vendedor: 20,
  user: 10,
};

/**
 * Verifica si roleA tiene permisos >= roleB.
 */
export function hasRoleAtLeast(roleA: UserRole, roleB: UserRole): boolean {
  return ROLE_HIERARCHY[roleA] >= ROLE_HIERARCHY[roleB];
}
