import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export type AuthClaims = {
  sub: string;          // id_usuario (uuid en texto)
  rol: string;          // admin|gerente|cajero|...
  sucursal_id?: string; // opcional
  correo?: string;      // opcional
};

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("Authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ ok: false, error: "SERVER_MISCONFIG_JWT_SECRET" });
  }

  try {
    const decoded = jwt.verify(token, secret) as AuthClaims;
    (req as any).auth = decoded;
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
}

