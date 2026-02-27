// src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from "express";
import { logger } from "../logger";
import { HttpError } from "../utils/http";

/**
 * Error handler global - debe montarse DESPUÉS de todos los routers.
 * Convierte excepciones a respuestas JSON uniformes.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  // HttpError conocido
  if (err instanceof HttpError) {
    return res.status(err.status).json({ ok: false, error: err.code });
  }

  // Error de CORS
  if (err instanceof Error && err.message === "Not allowed by CORS") {
    return res.status(403).json({ ok: false, error: "CORS_FORBIDDEN" });
  }

  // Error genérico
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, path: req.path, method: req.method }, "unhandled_error");

  return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
}
