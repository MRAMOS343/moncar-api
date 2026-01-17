// src/routes/fichasTecnicas.ts
import { Router, Request, Response } from "express";
import { query, withTransaction } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function clampLimit(raw: unknown, def = 100, max = 200) {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function parseCursorBigint(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "0";
  if (!/^\d+$/.test(s)) return "0";
  return s;
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

// Intenta convertir auth.sub a bigint (si tu usuarios.id fuera bigint). Si no, null.
function getUserIdBigintOrNull(req: Request): string | null {
  const auth = (req as any).auth as { sub?: string } | undefined;
  const sub = String(auth?.sub ?? "").trim();
  return /^\d+$/.test(sub) ? sub : null;
}

/**
 * GET /tech-sheets (alias: /fichas-tecnicas)
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
 */
router.get(
  ["/tech-sheets/:sku", "/fichas-tecnicas/:sku"],
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const sku = String(req.params.sku ?? "").trim();
      if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

      const fichaRows = await query<{
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

/**
 * PATCH /tech-sheets/:sku
 * Crea o actualiza la ficha (notas_generales).
 */
router.patch(
  ["/tech-sheets/:sku", "/fichas-tecnicas/:sku"],
  requireAuth,
  async (req: Request, res: Response) => {
    const auth = requireRoles(req, res, ["admin", "gerente"]);
    if (!auth) return;

    const sku = String(req.params.sku ?? "").trim();
    if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

    const notas_generales =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "notas_generales")
        ? (req.body?.notas_generales === null ? null : String(req.body?.notas_generales))
        : undefined;

    if (notas_generales === undefined) {
      return res.status(400).json({
        ok: false,
        error: "SIN_CAMBIOS",
        hint: "Envía { notas_generales } en el body.",
      });
    }

    try {
      // Requiere UNIQUE(sku) en DB para el ON CONFLICT
      const rows = await query<{
        id: string;
        sku: string;
        notas_generales: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `
        INSERT INTO fichas_tecnicas (sku, notas_generales)
        VALUES ($1, $2)
        ON CONFLICT (sku) DO UPDATE SET
          notas_generales = EXCLUDED.notas_generales,
          updated_at = now()
        RETURNING
          id::text AS id,
          sku,
          notas_generales,
          created_at,
          updated_at
        `,
        [sku, notas_generales]
      );

      return res.json({ ok: true, ficha: rows[0] });
    } catch (err) {
      console.error("[PATCH /tech-sheets/:sku] error", err);
      return res.status(500).json({ ok: false, error: "TECH_SHEET_UPSERT_FAILED" });
    }
  }
);

/**
 * POST /tech-sheets/:sku/attributes
 * Upsert de 1 atributo por nombre (requiere UNIQUE(ficha_id, nombre_atributo)).
 */
router.post(
  ["/tech-sheets/:sku/attributes", "/fichas-tecnicas/:sku/atributos"],
  requireAuth,
  async (req: Request, res: Response) => {
    const auth = requireRoles(req, res, ["admin", "gerente"]);
    if (!auth) return;

    const sku = String(req.params.sku ?? "").trim();
    if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

    const nombre_atributo = String(req.body?.nombre_atributo ?? "").trim();
    const valor = String(req.body?.valor ?? "").trim();
    const unidad = req.body?.unidad === undefined ? null : (req.body?.unidad === null ? null : String(req.body?.unidad).trim());

    if (!nombre_atributo) return res.status(400).json({ ok: false, error: "NOMBRE_ATRIBUTO_REQUERIDO" });
    if (!valor) return res.status(400).json({ ok: false, error: "VALOR_REQUERIDO" });

    const creado_por = getUserIdBigintOrNull(req); // puede ser null

    try {
      const result = await withTransaction(async (client) => {
        // 1) Obtener ficha id (debe existir, si no existe, la creamos con notas null)
        const fichaRows = await client.query(
          `
          INSERT INTO fichas_tecnicas (sku, notas_generales)
          VALUES ($1, NULL)
          ON CONFLICT (sku) DO UPDATE SET updated_at = now()
          RETURNING id::text AS id, sku, notas_generales, created_at, updated_at
          `,
          [sku]
        );
        const ficha = fichaRows.rows[0] as { id: string };

        // 2) Upsert atributo
        const atrRows = await client.query(
          `
          INSERT INTO fichas_tecnicas_atributos (ficha_id, nombre_atributo, valor, unidad, creado_por)
          VALUES ($1::bigint, $2, $3, $4, $5::bigint)
          ON CONFLICT (ficha_id, nombre_atributo) DO UPDATE SET
            valor = EXCLUDED.valor,
            unidad = EXCLUDED.unidad,
            updated_at = now()
          RETURNING
            id::text AS id,
            ficha_id::text AS ficha_id,
            nombre_atributo,
            valor,
            unidad,
            creado_por::text AS creado_por,
            created_at,
            updated_at
          `,
          // Si creado_por es null, el cast ::bigint funciona si mandamos null (ok)
          [ficha.id, nombre_atributo, valor, unidad, creado_por]
        );

        return { ficha_id: ficha.id, atributo: atrRows.rows[0] };
      });

      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[POST /tech-sheets/:sku/attributes] error", err);
      return res.status(500).json({ ok: false, error: "TECH_SHEET_ATTRIBUTE_UPSERT_FAILED" });
    }
  }
);

/**
 * PUT /tech-sheets/:sku/attributes
 * Upsert masivo: [{nombre_atributo, valor, unidad}]
 */
router.put(
  ["/tech-sheets/:sku/attributes", "/fichas-tecnicas/:sku/atributos"],
  requireAuth,
  async (req: Request, res: Response) => {
    const auth = requireRoles(req, res, ["admin", "gerente"]);
    if (!auth) return;

    const sku = String(req.params.sku ?? "").trim();
    if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });

    const items = Array.isArray(req.body?.atributos) ? req.body.atributos : null;
    if (!items) return res.status(400).json({ ok: false, error: "ATRIBUTOS_REQUERIDOS", hint: "Body: { atributos: [...] }" });

    const creado_por = getUserIdBigintOrNull(req);

    try {
      const out = await withTransaction(async (client) => {
        const fichaRows = await client.query(
          `
          INSERT INTO fichas_tecnicas (sku, notas_generales)
          VALUES ($1, NULL)
          ON CONFLICT (sku) DO UPDATE SET updated_at = now()
          RETURNING id::text AS id
          `,
          [sku]
        );
        const fichaId = (fichaRows.rows[0] as any).id as string;

        const saved: any[] = [];

        for (const it of items) {
          const nombre_atributo = String(it?.nombre_atributo ?? "").trim();
          const valor = String(it?.valor ?? "").trim();
          const unidad = it?.unidad === undefined ? null : (it?.unidad === null ? null : String(it?.unidad).trim());

          if (!nombre_atributo || !valor) continue;

          const r = await client.query(
            `
            INSERT INTO fichas_tecnicas_atributos (ficha_id, nombre_atributo, valor, unidad, creado_por)
            VALUES ($1::bigint, $2, $3, $4, $5::bigint)
            ON CONFLICT (ficha_id, nombre_atributo) DO UPDATE SET
              valor = EXCLUDED.valor,
              unidad = EXCLUDED.unidad,
              updated_at = now()
            RETURNING
              id::text AS id,
              ficha_id::text AS ficha_id,
              nombre_atributo,
              valor,
              unidad,
              creado_por::text AS creado_por,
              created_at,
              updated_at
            `,
            [fichaId, nombre_atributo, valor, unidad, creado_por]
          );

          saved.push(r.rows[0]);
        }

        return { ficha_id: fichaId, atributos: saved };
      });

      return res.json({ ok: true, ...out });
    } catch (err) {
      console.error("[PUT /tech-sheets/:sku/attributes] error", err);
      return res.status(500).json({ ok: false, error: "TECH_SHEET_ATTRIBUTES_BULK_FAILED" });
    }
  }
);

/**
 * DELETE /tech-sheets/:sku/attributes/:id
 */
router.delete(
  ["/tech-sheets/:sku/attributes/:id", "/fichas-tecnicas/:sku/atributos/:id"],
  requireAuth,
  async (req: Request, res: Response) => {
    const auth = requireRoles(req, res, ["admin", "gerente"]);
    if (!auth) return;

    const sku = String(req.params.sku ?? "").trim();
    const id = String(req.params.id ?? "").trim();

    if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });
    if (!/^\d+$/.test(id)) return res.status(400).json({ ok: false, error: "ID_INVALIDO" });

    try {
      // Validamos que el atributo pertenezca a la ficha del sku
      const deleted = await query<{ id: string }>(
        `
        DELETE FROM fichas_tecnicas_atributos a
        USING fichas_tecnicas f
        WHERE a.id = $1::bigint
          AND a.ficha_id = f.id
          AND f.sku = $2
        RETURNING a.id::text AS id
        `,
        [id, sku]
      );

      if (deleted.length === 0) {
        return res.status(404).json({ ok: false, error: "ATRIBUTO_NO_ENCONTRADO" });
      }

      return res.json({ ok: true, deleted_id: deleted[0].id });
    } catch (err) {
      console.error("[DELETE /tech-sheets/:sku/attributes/:id] error", err);
      return res.status(500).json({ ok: false, error: "TECH_SHEET_ATTRIBUTE_DELETE_FAILED" });
    }
  }
);

/**
 * (Opcional recomendado) GET /tech-sheets/attribute-options
 * Para dropdown: nombres + unidades sugeridas.
 */
router.get(
  ["/tech-sheets/attribute-options", "/fichas-tecnicas/opciones-atributos"],
  requireAuth,
  async (_req: Request, res: Response) => {
    try {
      const rows = await query<{
        nombre_atributo: string;
        unidad_sugerida: string | null;
        unidades_permitidas: string[] | null;
        activo: boolean;
      }>(
        `
        SELECT nombre_atributo, unidad_sugerida, unidades_permitidas, activo
        FROM catalogo_atributos
        WHERE activo = true
        ORDER BY nombre_atributo ASC
        `
      );

      return res.json({ ok: true, items: rows });
    } catch (err) {
      // Si aún no creas catalogo_atributos, no rompas: devuelve lista vacía
      return res.json({ ok: true, items: [] });
    }
  }
);

export default router;
