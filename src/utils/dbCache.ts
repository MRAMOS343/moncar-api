import { query } from "../db";
import { logger } from "../logger";

const TTL_SEGUNDOS = {
  kpis: 5 * 60,
  tendencia: 10 * 60,
  metodos_pago: 10 * 60,
  top_productos: 15 * 60,
  resumen_semanal: 30 * 60,
};

export type TipoCache = keyof typeof TTL_SEGUNDOS;

/**
 * Intenta leer del cache. Retorna null si no existe o ya expiró.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const rows = await query<{ datos: T }>(
      `SELECT datos
       FROM kpis_dashboard_cache
       WHERE cache_key = $1
         AND expira_en > now()`,
      [key]
    );

    return rows[0]?.datos ?? null;
  } catch (err) {
    logger.warn({ err, key }, "dbCache.get.error");
    return null;
  }
}

/**
 * Guarda/actualiza un valor en cache con TTL por tipo.
 */
export async function cacheSet<T>(
  key: string,
  tipo: TipoCache,
  datos: T
): Promise<void> {
  const ttl = TTL_SEGUNDOS[tipo];

  try {
    await query(
      `INSERT INTO kpis_dashboard_cache (cache_key, datos, expira_en)
       VALUES ($1, $2::jsonb, now() + $3 * INTERVAL '1 second')
       ON CONFLICT (cache_key)
       DO UPDATE SET
         datos        = EXCLUDED.datos,
         calculado_en = now(),
         expira_en    = now() + $3 * INTERVAL '1 second'`,
      [key, JSON.stringify(datos), ttl]
    );
  } catch (err) {
    logger.warn({ err, key, tipo }, "dbCache.set.error");
  }
}

/**
 * Invalida keys que contengan el patrón.
 */
export async function cacheInvalidate(patron: string): Promise<void> {
  try {
    await query(
      `DELETE FROM kpis_dashboard_cache
       WHERE cache_key LIKE $1`,
      [`%${patron}%`]
    );
    logger.info({ patron }, "dbCache.invalidated");
  } catch (err) {
    logger.warn({ err, patron }, "dbCache.invalidate.error");
  }
}

/**
 * Elimina entradas expiradas y reporta cuántas se limpiaron.
 */
export async function cacheLimpiarExpirados(): Promise<void> {
  try {
    const rows = await query<{ eliminados: number }>(
      `WITH deleted AS (
         DELETE FROM kpis_dashboard_cache
         WHERE expira_en < now()
         RETURNING 1
       )
       SELECT COUNT(*)::int AS eliminados FROM deleted`
    );

    const eliminados = Number(rows[0]?.eliminados ?? 0);
    if (eliminados > 0) {
      logger.info({ eliminados }, "dbCache.limpieza");
    }
  } catch (err) {
    logger.warn({ err }, "dbCache.limpieza.error");
  }
}
