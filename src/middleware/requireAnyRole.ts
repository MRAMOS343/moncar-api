// src/middleware/requireAnyRole.ts
import type { Request, Response, NextFunction } from "express";

export type UserRole = "admin" | "gerente" | "cajero" | "sync";


export function requireAnyRole(allowed: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as any).auth as { rol?: string } | undefined;
    const rol = String(auth?.rol ?? "").trim() as UserRole | "";

    // Si aquí prefieres 403 por consistencia, cambia 401->403.
    if (!rol) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED_NO_ROLE" });
    }

    if (!allowed.includes(rol)) {
      return res.status(403).json({
        ok: false,
        error: "FORBIDDEN_ROLE",
        allowed,
        got: rol,
      });
    }

    return next();
  };
}
