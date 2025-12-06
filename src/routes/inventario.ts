// src/routes/inventario.ts
import { Router } from "express";
import { query } from "../db";

const router = Router();

/**
 * GET /inventario
 *
 * Lista de existencias por SKU y almacén.
 * Query params:
 *   sku?: filtrar por SKU exacto
 *   almacen?: filtrar por almacén exacto
 *   limit?: número máximo de filas (default 100, máx 500)
 *
 * Regla: clamp de negativos a 0 en la respuesta.
 */
router.get("/inventario", async (req, res) => {
  try {
    const { sku, almacen, limit } = req.query;

    const pageSize = limit ? Math.min(Number(limit), 500) : 100;

    const filtros: string[] = [];
    const params: any[] = [];

    if (sku) {
      filtros.push(`sku = $${params.length + 1}`);
      params.push(String(sku));
    }

    if (almacen) {
      filtros.push(`almacen = $${params.length + 1}`);
      params.push(String(almacen));
    }

    const whereClause =
      filtros.length > 0 ? `WHERE ${filtros.join(" AND ")}` : "";

    const rows = await query<{
      sku: string;
      almacen: string | null;
      existencia: string; // numeric -> text
      actualizado_el: string | null;
    }>(
      `
      SELECT
        sku,
        almacen,
        existencia::text AS existencia,
        actualizado_el
      FROM inventario
      ${whereClause}
      ORDER BY sku, almacen
      LIMIT $${params.length + 1}
      `,
      [...params, pageSize]
    );

    // clamp de negativos a 0 para la UI
    const items = rows.map((r) => {
      const raw = Number(r.existencia ?? "0");
      const safeExistencia = raw < 0 ? 0 : raw;

      return {
        sku: r.sku,
        almacen: r.almacen,
        existencia: safeExistencia,
        actualizado_el: r.actualizado_el,
      };
    });

    return res.json({
      ok: true,
      items,
    });
  } catch (error) {
    console.error("[GET /inventario] error:", error);
    return res.status(500).json({
      ok: false,
      error: "INVENTARIO_LIST_FAILED",
    });
  }
});

export default router;

