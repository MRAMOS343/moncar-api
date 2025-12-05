// src/routes/health.ts
import { Router } from "express";
import { query } from "../db";

const router = Router();

/**
 * Liveness: solo indica que el proceso de la API está arriba.
 * No toca la base de datos.
 */
router.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    status: "up",
  });
});

/**
 * Readiness: verifica que la API puede hablar con la base de datos.
 * Ideal para checks de orquestador / monitoreo.
 */
router.get("/readiness", async (_req, res) => {
  const inicio = Date.now();
  try {
    await query("SELECT 1");
    const duracionMs = Date.now() - inicio;

    return res.json({
      ok: true,
      status: "ready",
      db: "up",
      duration_ms: duracionMs,
    });
  } catch (error) {
    console.error("[/readiness] Error al consultar la base:", error);
    return res.status(503).json({
      ok: false,
      status: "unready",
      db: "down",
      error: "DB_UNAVAILABLE",
    });
  }
});

/**
 * Health de DB más detallado (similar a readiness, pero lo dejamos
 * como endpoint “técnico” adicional).
 */
router.get("/health/db", async (_req, res) => {
  const inicio = Date.now();
  try {
    await query("SELECT 1");
    const duracionMs = Date.now() - inicio;

    return res.json({
      ok: true,
      db: "up",
      duration_ms: duracionMs,
    });
  } catch (error) {
    console.error("[/health/db] Error al consultar la base:", error);
    return res.status(500).json({
      ok: false,
      db: "down",
      error: "No se pudo consultar la base de datos",
    });
  }
});

/**
 * Endpoint de debug: info de conexión y conteos básicos.
 * Aquí usamos query(...) correctamente como T[], no como QueryResult.
 */
router.get("/debug/db-info", async (_req, res) => {
  try {
    const infoRows = await query<{
      host: string | null;
      port: number | null;
      db: string;
      schema: string;
      user: string;
    }>(
      `
      SELECT
        inet_server_addr()   AS host,
        inet_server_port()   AS port,
        current_database()   AS db,
        current_schema()     AS schema,
        current_user         AS user;
      `
    );

    const row = infoRows[0];

    const ventasRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ventas"
    );
    const lineasRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM lineas_venta"
    );
    const pagosRows = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pagos_venta"
    );

    const ventasCount = Number(ventasRows[0]?.count ?? "0");
    const lineasCount = Number(lineasRows[0]?.count ?? "0");
    const pagosCount = Number(pagosRows[0]?.count ?? "0");

    return res.json({
      ok: true,
      db_info: row,
      counts: {
        ventas: ventasCount,
        lineas_venta: lineasCount,
        pagos_venta: pagosCount,
      },
    });
  } catch (error) {
    console.error("[/debug/db-info] error:", error);
    return res.status(500).json({
      ok: false,
      error: "DB_INFO_FAILED",
    });
  }
});

export default router;
