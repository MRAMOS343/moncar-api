import { Router } from "express";
import { query } from "../db";

const router = Router();

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

export default router;


// Endpoint de debug: info de conexión y conteos básicos
router.get("/debug/db-info", async (_req, res) => {
  try {
    const info = await query<{
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

    const [row] = info;

    const [ventasCount] = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ventas"
    );
    const [lineasCount] = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM lineas_venta"
    );
    const [pagosCount] = await query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pagos_venta"
    );

    return res.json({
      ok: true,
      db_info: row,
      counts: {
        ventas: Number(ventasCount.count),
        lineas_venta: Number(lineasCount.count),
        pagos_venta: Number(pagosCount.count),
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

