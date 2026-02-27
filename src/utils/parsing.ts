// src/utils/parsing.ts

/**
 * Convierte string a boolean de forma consistente.
 */
export function parseBool(val: unknown): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const lower = val.toLowerCase().trim();
    return lower === "true" || lower === "1" || lower === "yes";
  }
  return Boolean(val);
}

/**
 * Parsea query string para búsqueda (trim + lowercase opcional).
 */
export function parseQ(val: unknown, lowercase = false): string {
  const s = String(val ?? "").trim();
  return lowercase ? s.toLowerCase() : s;
}

/**
 * Verifica si un string tiene formato UUID (v4).
 */
export function isUuidLike(val: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val);
}

/**
 * Verifica si un string es un ID numérico válido.
 */
export function isNumericId(val: string): boolean {
  return /^\d+$/.test(val);
}

/**
 * Clamp de límite para paginación.
 */
export function clampLimit(raw: unknown, def = 50, max = 200): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}
