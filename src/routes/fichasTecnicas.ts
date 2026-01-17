// src/routes/fichasTecnicas.ts
import { Router, Request, Response } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function clampLimit(raw: unknown, def = 100, max = 200) {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function parseCursorBigint(raw: unknown): string {
  // Cursor como string para NO perder precisión (bigint)
  const s = String(raw ?? "").trim();
  if (!s) return "0";
  // Acepta solo dígitos (0..9)
  if (!/^\d+$/.test(s)) return "0";
  return s;
}

/**
 * GET /tech-sheets (alias: /fichas-tecnicas)
 * Lista paginada por id, con filtros opcionales:
 *
 * Query:
 *  - cursor: id (string bigint). Devuelve id > cursor.
 *  - limit: 1..200
 *  - sku: sku exacto (opcional)
 *  - q: búsqueda parcial por sku (opcional, ILIKE %q%)
 */
router.get(
  ["/tech-sheets", "/fichas-tecnicas"],
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const cursor = parseCursorBigint(req.query.cursor);
      const limit = clampLimit(req.query.limit, 100, 200);

      const sku = String(req.query.sku ?? "").trim();
      const q = String(req.query.q ?? "").trim();

      const rows = await query<{
        id: string;
        sku: string;
        notas_generales: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `
        SELECT
          id::text AS id,
          sku,
          notas_generales,
          created_at,
          updated_at
        FROM fichas_tecnicas
        WHERE id > $1::bigint
          AND ($2 = '' OR sku = $2)
          AND ($3 = '' OR sku ILIKE ('%' || $3 || '%'))
        ORDER BY id ASC
        LIMIT $4
        `,
        [cursor, sku, q, limit]
      );

      const next_cursor = rows.length === limit ? rows[rows.length - 1].id : null;

      return res.json({ ok: true, items: rows, next_cursor });
    } catch (err) {
      console.error("[GET /tech-sheets] error", err);
      return res.status(500).json({ ok: false, error: "TECH_SHEETS_LIST_FAILED" });
    }
  }
);

/**
 * GET /tech-sheets/:sku (alias: /fichas-tecnicas/:sku)
 * Devuelve la ficha más reciente para el sku + sus atributos
 *
 * Respuesta:
 *  { ok:true, ficha, atributos, atributos_map }
 */
router.get(
  ["/tech-sheets/:sku", "/fichas-tecnicas/:sku"],
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const sku = String(req.params.sku ?? "").trim();
      if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

      const fichaRows = await query<{
        id: string; // lo regresamos string para no arriesgar bigint
        sku: string;
        notas_generales: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `
        SELECT
          id::text AS id,
          sku,
          notas_generales,
          created_at,
          updated_at
        FROM fichas_tecnicas
        WHERE sku = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [sku]
      );

      if (fichaRows.length === 0) {
        return res.status(404).json({ ok: false, error: "FICHA_NO_ENCONTRADA" });
      }

      const ficha = fichaRows[0];

      const atributos = await query<{
        id: string;
        ficha_id: string;
        nombre_atributo: string;
        valor: string;
        unidad: string | null;
        creado_por: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `
        SELECT
          id::text AS id,
          ficha_id::text AS ficha_id,
          nombre_atributo,
          valor,
          unidad,
          creado_por::text AS creado_por,
          created_at,
          updated_at
        FROM fichas_tecnicas_atributos
        WHERE ficha_id = $1::bigint
        ORDER BY id ASC
        `,
        [ficha.id]
      );

      // Para UI: acceso directo por clave (si hay duplicados, gana el último)
      const atributos_map: Record<string, { valor: string; unidad: string | null }> = {};
      for (const a of atributos) {
        atributos_map[a.nombre_atributo] = { valor: a.valor, unidad: a.unidad };
      }

      return res.json({ ok: true, ficha, atributos, atributos_map });
    } catch (err) {
      console.error("[GET /tech-sheets/:sku] error", err);
      return res.status(500).json({ ok: false, error: "TECH_SHEET_DETAIL_FAILED" });
    }
  }
);

export default router;
