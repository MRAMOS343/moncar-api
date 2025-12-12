// src/middleware/auth.ts
import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { env } from "../env";

interface TokenPayload extends JwtPayload {
  sub: string;   // id de usuario
  role?: string; // 'admin', 'empleado', etc.
}

/**
 * Middleware de autenticación por JWT.
 * Requiere header: Authorization: Bearer <token>
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, reason: "NO_TOKEN" });
  }

  const token = authHeader.substring("Bearer ".length);

  try {
    const decoded = jwt.verify(token, env.jwt.secret) as TokenPayload;

    // Guardamos información básica del usuario en la request
    (req as any).user = {
      id: decoded.sub,
      role: decoded.role ?? "user",
    };

    return next();
  } catch (err) {
    return res.status(401).json({ ok: false, reason: "INVALID_TOKEN" });
  }
}

/**
 * Middleware de autorización por rol.
 * Ejemplo de uso: requireRole("admin")
 */
export function requireRole(requiredRole: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user) {
      return res.status(401).json({ ok: false, reason: "NO_USER_IN_REQUEST" });
    }

    if (user.role !== requiredRole) {
      return res.status(403).json({ ok: false, reason: "FORBIDDEN" });
    }

    return next();
  };
}

