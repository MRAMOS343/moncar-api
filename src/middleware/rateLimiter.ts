// src/middleware/rateLimiter.ts
import rateLimit from "express-rate-limit";

/**
 * Rate limiter estricto para endpoints de autenticación.
 * 10 intentos cada 15 minutos.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10,
  message: { ok: false, error: "RATE_LIMITED" },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter general para la API.
 * 200 requests por minuto.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 200,
  message: { ok: false, error: "RATE_LIMITED" },
  standardHeaders: true,
  legacyHeaders: false,
});
