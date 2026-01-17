// src/routes/inventario.ts
import { Router, Request, Response } from "express";
import { query, withTransaction } from "../db";
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

function parseDecimal(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
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

/**
 * GET /inventario
 *
 * Query params:
 *   sku?: exacto
 *   almacen?: exacto
 *   limit?: default 100, max 500
 *
 * Paginación (opcional, keyset ASC):
 *   cursor_sku?: sku último
 *   cursor_almacen?: almacen último
 *
 * Respuesta:
 *  { ok:true, items:[...], next_cursor:{cursor_sku,cursor_almacen}|null }
 */
router.get("/inventario", requireAuth, async (req: Request, res: Response) => {
  try {
    const sku = String(req.query.sku ?? "").trim();
    const almacen = String(req.query.almacen ?? "").trim();
    const limit = clampLimit(req.query.limit, 100, 500);

    const cursorSku = parseCursorText(req.query.cursor_sku);
    const cursorAlmacen = parseCursorText(req.query.cursor_almacen);

    if ((cursorSku && !cursorAlmacen) || (!cursorSku && cursorAlmacen)) {
      return res.status(400).json({
        ok: false,
        error: "CURSOR_INVALIDO",
        hint: "Debes enviar cursor_sku y cursor_almacen juntos.",
      });
    }

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

    // UI clamp (por si existiera un valor negativo viejo en DB)
    const items = rows.map((r) => {
      const raw = Number(r.existencia ?? "0");
      const safe = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      return {
        sku: r.sku,
        almacen: r.almacen,
        existencia: safe.toFixed(4).replace(/\.?0+$/, ""),
        actualizado_el: r.actualizado_el,
      };
    });

    const hasNext = rows.length === limit;
    const last = hasNext ? rows[rows.length - 1] : null;

    return res.json({
      ok: true,
      items,
      next_cursor: hasNext ? { cursor_sku: last!.sku, cursor_almacen: last!.almacen } : null,
    });
  } catch (error) {
    console.error("[GET /inventario] error:", error);
    return res.status(500).json({ ok: false, error: "INVENTARIO_LIST_FAILED" });
  }
});

/**
 * POST /inventario/adjust
 *
 * Body:
 *  { sku: string, almacen: string, delta: number, motivo: string, referencia?: string }
 *
 * Hace:
 *  1) INSERT en inventario_movimientos
 *  2) UPSERT inventario sumando delta (clamp a 0)
 *
 * Respuesta:
 *  { ok:true, sku, almacen, existencia, movimiento_id }
 */
router.post("/inventario/adjust", requireAuth, async (req: Request, res: Response) => {
  // Permisos: ajusta roles a tu gusto
  const auth = requireRoles(req, res, ["admin", "gerente"]);
  if (!auth) return;

  const sku = String(req.body?.sku ?? "").trim();
  const almacen = String(req.body?.almacen ?? "").trim();
  const motivo = String(req.body?.motivo ?? "").trim();
  const referencia = req.body?.referencia != null ? String(req.body.referencia).trim() : null;

  const delta = parseDecimal(req.body?.delta);

  if (!sku) return res.status(400).json({ ok: false, error: "SKU_REQUERIDO" });
  if (!almacen) return res.status(400).json({ ok: false, error: "ALMACEN_REQUERIDO" });
  if (delta === null) return res.status(400).json({ ok: false, error: "DELTA_INVALIDO" });
  if (!motivo) return res.status(400).json({ ok: false, error: "MOTIVO_REQUERIDO" });

  try {
    const result = await withTransaction(async (client) => {
      // 1) Insert movimiento
      const mov = await client.query<{ id: string }>(
        `
        INSERT INTO inventario_movimientos (
          sku, almacen, delta, motivo, actor_user_id, referencia
        ) VALUES (
          $1, $2, $3::numeric, $4, $5::uuid, $6
        )
        RETURNING id::text AS id
        `,
        [sku, almacen, delta, motivo, auth.sub ?? null, referencia]
      );

      const movimientoId = mov.rows[0].id;

      // 2) Upsert inventario con clamp a 0
      // Nota: requiere PK (sku, almacen)
      const up = await client.query<{
        existencia: string;
        actualizado_el: string;
      }>(
        `
        INSERT INTO inventario (sku, almacen, existencia, actualizado_el)
        VALUES ($1, $2, GREATEST(0, $3::numeric), now())
        ON CONFLICT (sku, almacen) DO UPDATE
        SET
          existencia = GREATEST(0, inventario.existencia + $3::numeric),
          actualizado_el = now()
        RETURNING existencia::text AS existencia, actualizado_el
        `,
        [sku, almacen, delta]
      );

      return {
        movimiento_id: movimientoId,
        existencia: up.rows[0].existencia,
        actualizado_el: up.rows[0].actualizado_el,
      };
    });

    return res.json({
      ok: true,
      sku,
      almacen,
      existencia: Number(result.existencia).toFixed(4).replace(/\.?0+$/, ""),
      actualizado_el: result.actualizado_el,
      movimiento_id: result.movimiento_id,
    });
  } catch (error) {
    console.error("[POST /inventario/adjust] error:", error);
    return res.status(500).json({ ok: false, error: "INVENTARIO_ADJUST_FAILED" });
  }
});

export default router;
