import type { Request, Response, NextFunction } from "express";

export function requireAnyRole(allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as any).auth as { rol?: string } | undefined;
    const rol = String(auth?.rol ?? "").trim();

    if (!rol) {
      return res.status(403).json({ ok: false, error: "FORBIDDEN_NO_ROLE" });
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

