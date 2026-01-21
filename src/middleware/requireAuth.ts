import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export type AuthClaims = {
  sub: string;                 // id_usuario (uuid en texto)
  rol?: string;                // admin|gerente|cajero|sync|...
  role?: string;               // compat: algunos tokens traen "role"
  sucursal_id?: string;        // opcional
  correo?: string;             // opcional
  email?: string;              // compat: algunos tokens traen "email"
  source_id?: string;          // opcional (si decides meterlo en el token)
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

    // Normalización para compatibilidad: rol <- role
    if (!decoded.rol && decoded.role) decoded.rol = decoded.role;

    // Normalización opcional: correo <- email
    if (!decoded.correo && decoded.email) decoded.correo = decoded.email;

    (req as any).auth = decoded;
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
}
