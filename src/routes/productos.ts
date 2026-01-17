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
  return String(raw ?? "").trim();
}

function parseDecimal(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseIntOrNull(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function requireRoles(req: Request, res: Response, roles: string[]) {
  const auth = (req as any).auth as { rol?: string; sub?: string } | undefined;
  const rol = auth?.rol ?? "";
  if (!roles.includes(rol)) {
    res.status(403).json({ ok: false, error: "FORBIDDEN" });
    return null;
  }
  return auth;
}

async function fetchProductoBySku(sku: string) {
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
      precio1::text     AS precio1,
      impuesto::text    AS impuesto,
      unidad,
      minimo::text      AS minimo,
      maximo::text      AS maximo,
      costo_u::text     AS costo_u,
      cost_total::text  AS cost_total,
      notes,
      image_url,
      u1, u2, u3,
      ubicacion,
      movimientos,
      clasificacion,
      rop::text         AS rop,
      rotacion::text    AS rotacion,
      created_at,
      updated_at
    FROM productos
    WHERE sku = $1
    LIMIT 1
    `,
    [sku]
  );

  return rows[0] ?? null;
}

/**
 * GET /products (alias: /productos)
 */
router.get(
  ["/products", "/productos"],
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const limit = clampLimit(req.query.limit, 100, 200);
      const q = String(req.query.q ?? "").trim();
      const cursor = q ? "" : parseCursorSku(req.query.cursor);

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
          precio1::text     AS precio1,
          impuesto::text    AS impuesto,
          unidad,
          minimo::text      AS minimo,
          maximo::text      AS maximo,
          costo_u::text     AS costo_u,
          cost_total::text  AS cost_total,
          notes,
          image_url,
          u1, u2, u3,
          ubicacion,
          movimientos,
          clasificacion,
          rop::text         AS rop,
          rotacion::text    AS rotacion,
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
 * GET /products/:sku (alias: /productos/:sku)
 */
router.get(
  ["/products/:sku", "/productos/:sku"],
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const sku = String(req.params.sku ?? "").trim();
      if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

      const item = await fetchProductoBySku(sku);
      if (!item) return res.status(404).json({ ok: false, error: "SKU_NO_ENCONTRADO" });

      return res.json({ ok: true, item });
    } catch (err) {
      console.error("[GET /products/:sku] error", err);
      return res.status(500).json({ ok: false, error: "PRODUCT_DETAIL_FAILED" });
    }
  }
);

/**
 * PATCH /products/:sku (alias: /productos/:sku)
 * Edición parcial (correcto):
 * - Solo campos permitidos (whitelist)
 * - updated_at = now()
 * - Requiere rol admin/gerente
 *
 * Body (ejemplo):
 * { "descrip":"...", "precio1":150, "impuesto":24, "minimo":5, "maximo":50, "marca":"..." }
 */
router.patch(
  ["/products/:sku", "/productos/:sku"],
  requireAuth,
  async (req: Request, res: Response) => {
    const auth = requireRoles(req, res, ["admin", "gerente"]);
    if (!auth) return;

    const sku = String(req.params.sku ?? "").trim();
    if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

    // Verificar existe
    const before = await fetchProductoBySku(sku);
    if (!before) return res.status(404).json({ ok: false, error: "SKU_NO_ENCONTRADO" });

    // Whitelist de campos editables
    const body = req.body ?? {};

    const updates: { col: string; val: any }[] = [];

    // texto
    const textFields: Array<[string, string]> = [
      ["descrip", "descrip"],
      ["linea", "linea"],
      ["marca", "marca"],
      ["unidad", "unidad"],
      ["notes", "notes"],
      ["image_url", "image_url"],
      ["u1", "u1"],
      ["u2", "u2"],
      ["u3", "u3"],
      ["ubicacion", "ubicacion"],
      ["clasificacion", "clasificacion"],
    ];

    for (const [key, col] of textFields) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const v = body[key];
        updates.push({ col, val: v === null ? null : String(v).trim() });
      }
    }

    // numéricos
    const numericFields: Array<[string, string]> = [
      ["precio1", "precio1"],
      ["impuesto", "impuesto"],
      ["minimo", "minimo"],
      ["maximo", "maximo"],
      ["costo_u", "costo_u"],
      ["cost_total", "cost_total"],
      ["rop", "rop"],
      ["rotacion", "rotacion"],
    ];

    for (const [key, col] of numericFields) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const v = body[key];
        if (v === null) {
          updates.push({ col, val: null });
        } else {
          const n = parseDecimal(v);
          if (n === null) {
            return res.status(400).json({ ok: false, error: "VALOR_NUMERICO_INVALIDO", field: key });
          }
          updates.push({ col, val: n });
        }
      }
    }

    // enteros
    if (Object.prototype.hasOwnProperty.call(body, "movimientos")) {
      const v = body.movimientos;
      if (v === null) updates.push({ col: "movimientos", val: null });
      else {
        const n = parseIntOrNull(v);
        if (n === null) return res.status(400).json({ ok: false, error: "ENTERO_INVALIDO", field: "movimientos" });
        updates.push({ col: "movimientos", val: n });
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "SIN_CAMBIOS",
        hint: "Envía al menos un campo editable en el body.",
      });
    }

    // Construir UPDATE seguro
    const sets: string[] = [];
    const params: any[] = [];

    for (const u of updates) {
      params.push(u.val);
      sets.push(`${u.col} = $${params.length}`);
    }

    // updated_at
    sets.push(`updated_at = now()`);

    // sku param al final
    params.push(sku);

    try {
      await query(
        `
        UPDATE productos
        SET ${sets.join(", ")}
        WHERE sku = $${params.length}
        `,
        params
      );

      const after = await fetchProductoBySku(sku);

      // (Opcional recomendado) audit_log:
      // - Si quieres, aquí insertamos un registro en audit_log con before/after

      return res.json({ ok: true, item: after });
    } catch (err) {
      console.error("[PATCH /products/:sku] error", err);
      return res.status(500).json({ ok: false, error: "PRODUCT_UPDATE_FAILED" });
    }
  }
);

export default router;
