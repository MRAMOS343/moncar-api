// src/routes/fichasTecnicas.ts
import { Router } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function clampLimit(raw: unknown, def = 100, max = 200) {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, 1), max);
}

/**
 * GET /tech-sheets (alias: /fichas-tecnicas)
 * Lista paginada por id, con filtro opcional por sku
 *
 * Query:
 *  - cursor: id (id > cursor)
 *  - limit: 1..200
 *  - sku: sku exacto (opcional)
 */
router.get(["/tech-sheets", "/fichas-tecnicas"], requireAuth, async (req, res) => {
  try {
    const cursor = Number(req.query.cursor ?? 0);
    const limit = clampLimit(req.query.limit, 100, 200);
    const sku = String(req.query.sku ?? "").trim();

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
      ORDER BY id ASC
      LIMIT $3
      `,
      [cursor, sku, limit]
    );

    const next_cursor = rows.length === limit ? Number(rows[rows.length - 1].id) : null;
    return res.json({ ok: true, items: rows, next_cursor });
  } catch (err) {
    console.error("[GET /tech-sheets] error", err);
    return res.status(500).json({ ok: false, error: "TECH_SHEETS_LIST_FAILED" });
  }
});

/**
 * GET /tech-sheets/:sku (alias: /fichas-tecnicas/:sku)
 * Devuelve la ficha más reciente para el sku + sus atributos
 */
router.get(["/tech-sheets/:sku", "/fichas-tecnicas/:sku"], requireAuth, async (req, res) => {
  try {
    const sku = String(req.params.sku ?? "").trim();
    if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

    const fichaRows = await query<{
      id: number;
      sku: string;
      notas_generales: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `
      SELECT
        id,
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
      WHERE ficha_id = $1
      ORDER BY id ASC
      `,
      [ficha.id]
    );

    return res.json({ ok: true, ficha, atributos });
  } catch (err) {
    console.error("[GET /tech-sheets/:sku] error", err);
    return res.status(500).json({ ok: false, error: "TECH_SHEET_DETAIL_FAILED" });
  }
});

export default router;
