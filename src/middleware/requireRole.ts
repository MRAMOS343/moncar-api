import { Request, Response, NextFunction } from "express";
import { UserRole } from "./requireAnyRole";

/**
 * requireRole(["admin","gerente"])
 * Asume que requireAuth ya puso req.user.role
 */
export function requireRole(allowed: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req as any)?.user?.role as UserRole | undefined;
    if (!role) return res.status(401).json({ ok: false, reason: "NO_AUTH" });
    if (!allowed.includes(role)) {
      return res.status(403).json({ ok: false, reason: "FORBIDDEN" });
    }
    next();
  };
}
