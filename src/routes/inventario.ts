// src/routes/inventario.ts
import { Router, Request, Response } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function clampLimit(raw: unknown, def = 100, max = 500) {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function parseCursorText(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return s ? s : null;
}

/**
 * GET /inventario
 *
 * Lista de existencias por SKU y almacén.
 * Query params:
 *   sku?: filtrar por SKU exacto
 *   almacen?: filtrar por almacén exacto
 *   limit?: número máximo de filas (default 100, máx 500)
 *
 * Paginación (opcional, recomendado si crece):
 *   cursor_sku?: sku del último registro recibido
 *   cursor_almacen?: almacen del último registro recibido
 *
 * Regla UI: clamp de negativos a 0 en la respuesta.
 */
router.get("/inventario", requireAuth, async (req: Request, res: Response) => {
  try {
    const sku = String(req.query.sku ?? "").trim();
    const almacen = String(req.query.almacen ?? "").trim();
    const limit = clampLimit(req.query.limit, 100, 500);

    // Cursor compuesto (keyset)
    const cursorSku = parseCursorText(req.query.cursor_sku);
    const cursorAlmacen = parseCursorText(req.query.cursor_almacen);

    if ((cursorSku && !cursorAlmacen) || (!cursorSku && cursorAlmacen)) {
      return res.status(400).json({
        ok: false,
        error: "CURSOR_INVALIDO",
        hint: "Debes enviar cursor_sku y cursor_almacen juntos.",
      });
    }

    // Filtros
    const filtros: string[] = [];
    const params: any[] = [];

    if (sku) {
      filtros.push(`sku = $${params.length + 1}`);
      params.push(sku);
    }

    if (almacen) {
      filtros.push(`almacen = $${params.length + 1}`);
      params.push(almacen);
    }

    // Cursor: (sku, almacen) > (cursorSku, cursorAlmacen) para ORDER BY ASC
    if (cursorSku && cursorAlmacen) {
      filtros.push(`(sku, almacen) > ($${params.length + 1}, $${params.length + 2})`);
      params.push(cursorSku, cursorAlmacen);
    }

    const whereClause = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";

    const rows = await query<{
      sku: string;
      almacen: string;
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
      ORDER BY sku ASC, almacen ASC
      LIMIT $${params.length + 1}
      `,
      [...params, limit]
    );

    // clamp de negativos a 0 (pero devolvemos string para consistencia)
    const items = rows.map((r) => {
      const raw = Number(r.existencia ?? "0");
      const safe = Number.isFinite(raw) ? Math.max(0, raw) : 0;

      return {
        sku: r.sku,
        almacen: r.almacen,
        existencia: safe.toFixed(4).replace(/\.?0+$/, ""), // "12", "12.5", "12.3456"
        actualizado_el: r.actualizado_el,
      };
    });

    const hasNext = rows.length === limit;
    const last = hasNext ? rows[rows.length - 1] : null;

    return res.json({
      ok: true,
      items,
      next_cursor: hasNext
        ? { cursor_sku: last!.sku, cursor_almacen: last!.almacen }
        : null,
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
