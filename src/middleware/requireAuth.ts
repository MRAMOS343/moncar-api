// src/middleware/requireAuth.ts
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export type AuthClaims = {
  sub: string;                 // id_usuario (uuid en texto)
  rol?: string;                // admin|gerente|cajero|sync|...
  role?: string;               // compat
  sucursal_id?: string;
  correo?: string;
  email?: string;              // compat
  source_id?: string;
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

    // Normalización: rol <- role
    if (!decoded.rol && decoded.role) decoded.rol = decoded.role;

    // Normalización: correo <- email
    if (!decoded.correo && decoded.email) decoded.correo = decoded.email;

    // ✅ Estándar actual del repo
    (req as any).auth = decoded;

    // ✅ Compat con rutas que esperan req.user
    (req as any).user = {
      id: String(decoded.sub),
      role: String(decoded.rol ?? "user"),
      sucursal_id: decoded.sucursal_id ?? null,
      correo: decoded.correo ?? null,
    };

    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
}

