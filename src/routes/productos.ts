// src/routes/productos.ts
import { Router, Request, Response } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function clampLimit(raw: unknown, def = 100, max = 200) {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function parseCursorSku(raw: unknown): string {
  // cursor = sku (texto)
  const s = String(raw ?? "").trim();
  return s;
}

/**
 * GET /products  (alias: /productos)
 *
 * Listado paginado por cursor (sku) cuando NO hay búsqueda.
 * Si q != '', se hace búsqueda y se deshabilita cursor (next_cursor = null).
 *
 * Query:
 *  - cursor: sku (keyset: sku > cursor) (solo cuando q = '')
 *  - limit: 1..200 (default 100)
 *  - q: texto para buscar en sku o descrip (ILIKE)
 */
router.get(
  ["/products", "/productos"],
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const limit = clampLimit(req.query.limit, 100, 200);
      const q = String(req.query.q ?? "").trim();
      const cursor = q ? "" : parseCursorSku(req.query.cursor); // ✅ si hay q, ignoramos cursor

      const rows = await query<{
        sku: string;
        descrip: string;
        linea: string | null;
        marca: string | null;
        precio1: string | null;
        impuesto: string | null;
        unidad: string | null;
        minimo: string | null;
        maximo: string | null;
        costo_u: string | null;
        cost_total: string | null;
        notes: string | null;
        image_url: string | null;
        u1: string | null;
        u2: string | null;
        u3: string | null;
        ubicacion: string | null;
        movimientos: number | null;
        clasificacion: string | null;
        rop: string | null;
        rotacion: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>(
        `
        SELECT
          sku,
          descrip,
          linea,
          marca,
          precio1::text    AS precio1,
          impuesto::text   AS impuesto,
          unidad,
          minimo::text     AS minimo,
          maximo::text     AS maximo,
          costo_u::text    AS costo_u,
          cost_total::text AS cost_total,
          notes,
          image_url,
          u1, u2, u3,
          ubicacion,
          movimientos,
          clasificacion,
          rop::text        AS rop,
          rotacion::text   AS rotacion,
          created_at,
          updated_at
        FROM productos
        WHERE
          ($1 = '' OR sku > $1)
          AND (
            $2 = '' OR
            sku ILIKE ('%' || $2 || '%') OR
            descrip ILIKE ('%' || $2 || '%')
          )
        ORDER BY sku ASC
        LIMIT $3
        `,
        [cursor, q, limit]
      );

      // ✅ Cursor solo cuando q está vacío (listado puro)
      const next_cursor = !q && rows.length === limit ? rows[rows.length - 1].sku : null;

      return res.json({
        ok: true,
        items: rows,
        next_cursor,
        mode: q ? "search" : "cursor",
      });
    } catch (err) {
      console.error("[GET /products] error", err);
      return res.status(500).json({ ok: false, error: "PRODUCTS_LIST_FAILED" });
    }
  }
);

/**
 * GET /products/:sku  (alias: /productos/:sku)
 * Detalle de producto por SKU
 */
router.get(
  ["/products/:sku", "/productos/:sku"],
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const sku = String(req.params.sku ?? "").trim();
      if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

      const rows = await query<{
        sku: string;
        descrip: string;
        linea: string | null;
        marca: string | null;
        precio1: string | null;
        impuesto: string | null;
        unidad: string | null;
        minimo: string | null;
        maximo: string | null;
        costo_u: string | null;
        cost_total: string | null;
        notes: string | null;
        image_url: string | null;
        u1: string | null;
        u2: string | null;
        u3: string | null;
        ubicacion: string | null;
        movimientos: number | null;
        clasificacion: string | null;
        rop: string | null;
        rotacion: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>(
        `
        SELECT
          sku,
          descrip,
          linea,
          marca,
          precio1::text    AS precio1,
          impuesto::text   AS impuesto,
          unidad,
          minimo::text     AS minimo,
          maximo::text     AS maximo,
          costo_u::text    AS costo_u,
          cost_total::text AS cost_total,
          notes,
          image_url,
          u1, u2, u3,
          ubicacion,
          movimientos,
          clasificacion,
          rop::text        AS rop,
          rotacion::text   AS rotacion,
          created_at,
          updated_at
        FROM productos
        WHERE sku = $1
        LIMIT 1
        `,
        [sku]
      );

      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: "SKU_NO_ENCONTRADO" });
      }

      return res.json({ ok: true, item: rows[0] });
    } catch (err) {
      console.error("[GET /products/:sku] error", err);
      return res.status(500).json({ ok: false, error: "PRODUCT_DETAIL_FAILED" });
    }
  }
);

export default router;
