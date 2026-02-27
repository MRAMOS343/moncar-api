// src/config.ts
/**
 * Configuración centralizada de la aplicación.
 * Todas las variables de entorno se leen aquí.
 */

import { env } from "./env";

export const config = {
  // Server
  port: env.port,
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",

  // Auth
  auth: {
    maxFailedAttempts: Number(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? 8),
    lockMinutes: Number(process.env.AUTH_LOCK_MINUTES ?? 15),
  },

  // Sucursal (modo single-store)
  forcedSucursalId: process.env.FORCED_SUCURSAL_ID ?? "moncar",

  // Source ID para sync
  sourceId: process.env.SOURCE_ID ?? null,

  // Features flags
  features: {
    filesEnabled: String(process.env.FILES_ENABLED ?? "").toLowerCase() === "true",
  },

  // Pagination defaults
  pagination: {
    defaultLimit: 50,
    maxLimit: 200,
  },

  // Logging
  logLevel: process.env.LOG_LEVEL ?? "info",
} as const;

/**
 * Valida que las configuraciones críticas estén presentes al arrancar.
 */
export function validateConfig() {
  const errors: string[] = [];

  if (config.isProduction && !config.sourceId) {
    errors.push("SOURCE_ID es requerido en producción");
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  - ${errors.join("\n  - ")}`);
  }
}
