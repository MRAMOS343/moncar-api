// src/routes/health.ts
import { Router } from "express";
import { query, pool } from "../db";
import { queryDocs, poolDocs } from "../dbDocs";
import { logger } from "../logger";

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
    logger.error({ err: error }, "readiness.db.error");
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
    logger.error({ err: error }, "health.db.error");
    return res.status(500).json({
      ok: false,
      db: "down",
      error: "No se pudo consultar la base de datos",
    });
  }
});

/**
 * Health check completo: verifica ambas DBs y métricas del pool.
 */
router.get("/health/full", async (_req, res) => {
  const start = Date.now();
  const checks: Record<string, { status: string; latency_ms?: number; error?: string }> = {};

  // Check main DB
  try {
    const dbStart = Date.now();
    await query("SELECT 1");
    checks.db_main = { status: "up", latency_ms: Date.now() - dbStart };
  } catch (err) {
    checks.db_main = { status: "down", error: err instanceof Error ? err.message : "unknown" };
  }

  // Check docs DB
  try {
    const docsStart = Date.now();
    await queryDocs("SELECT 1");
    checks.db_docs = { status: "up", latency_ms: Date.now() - docsStart };
  } catch (err) {
    checks.db_docs = { status: "down", error: err instanceof Error ? err.message : "unknown" };
  }

  // Pool metrics
  const poolMetrics = {
    main: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    },
    docs: {
      total: poolDocs.totalCount,
      idle: poolDocs.idleCount,
      waiting: poolDocs.waitingCount,
    },
  };

  const allUp = Object.values(checks).every((c) => c.status === "up");

  return res.status(allUp ? 200 : 503).json({
    ok: allUp,
    status: allUp ? "healthy" : "degraded",
    checks,
    pools: poolMetrics,
    uptime_s: Math.floor(process.uptime()),
    total_latency_ms: Date.now() - start,
  });
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
    logger.error({ err: error }, "debug.db-info.error");
    return res.status(500).json({
      ok: false,
      error: "DB_INFO_FAILED",
    });
  }
});

export default router;
