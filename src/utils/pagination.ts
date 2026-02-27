// src/utils/pagination.ts

/**
 * Parsea parámetros de paginación con límites seguros.
 */
export function parsePagination(
  query: { limit?: string; offset?: string; cursor?: string },
  defaults: { maxLimit?: number; defaultLimit?: number } = {}
): { limit: number; offset: number; cursor: string | null } {
  const { maxLimit = 1000, defaultLimit = 50 } = defaults;

  let limit = parseInt(query.limit ?? "", 10);
  if (isNaN(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;

  let offset = parseInt(query.offset ?? "", 10);
  if (isNaN(offset) || offset < 0) offset = 0;

  const cursor = query.cursor?.trim() || null;

  return { limit, offset, cursor };
}
