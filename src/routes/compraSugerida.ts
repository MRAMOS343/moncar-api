import { Router } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler, HttpError } from "../utils/http";
import { logger } from "../logger";
import { recalcularCompraSugerida } from "../jobs/compraSugeridaJob";

const router = Router();

// GET /api/v1/compras/sugerida
// Lista de productos que necesitan reabastecimiento
router.get("/compras/sugerida", requireAuth,
  asyncHandler(async (req, res) => {
    const {
      sucursal_id,
      prioridad,    // filtro opcional: 'urgente' | 'normal' | 'opcional'
      page = "1",
      limit = "50",
    } = req.query as Record<string, string>;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const params: any[] = [sucursal_id ?? null, parseInt(limit), offset];
    const prioridadFilter = prioridad
      ? `AND c.prioridad = $${params.push(prioridad)}`
      : "";

    const [items, countRows] = await Promise.all([

      query(
        `SELECT
           c.producto_sku                             AS sku,
           p.descrip                                  AS nombre,
           p.marca,
           p.linea                                    AS categoria,
           p.precio1                                  AS precio,
           p.unidad,
           c.stock_actual,
           p.minimo                                   AS stock_minimo,
           p.maximo                                   AS stock_maximo,
           c.promedio_diario,
           c.dias_cobertura,
           c.cantidad_sugerida,
           c.prioridad,
           c.calculado_en
         FROM compra_sugerida_cache c
         LEFT JOIN productos p ON p.sku = c.producto_sku
         WHERE
           ($1::text IS NULL OR c.sucursal_id = $1)
           ${prioridadFilter}
         ORDER BY
           CASE c.prioridad
             WHEN 'urgente'   THEN 1
             WHEN 'normal'    THEN 2
             WHEN 'opcional'  THEN 3
           END,
           c.dias_cobertura ASC
         LIMIT $2 OFFSET $3`,
        params
      ),

      // Count query — usa parámetros en lugar de interpolación directa
      query(
        `SELECT COUNT(*)::integer AS total
         FROM compra_sugerida_cache c
         WHERE
           ($1::text IS NULL OR c.sucursal_id = $1)
           ${prioridad ? "AND c.prioridad = $2" : ""}`,
        prioridad ? [sucursal_id ?? null, prioridad] : [sucursal_id ?? null]
      ),

    ]);

    // Resumen de conteos por prioridad
    const resumenRows = await query<{
      prioridad: string;
      cantidad: string;
    }>(
      `SELECT prioridad, COUNT(*)::integer AS cantidad
       FROM compra_sugerida_cache
       WHERE ($1::text IS NULL OR sucursal_id = $1)
       GROUP BY prioridad`,
      [sucursal_id ?? null]
    );

    const resumen = { urgente: 0, normal: 0, opcional: 0 };
    resumenRows.forEach(r => {
      resumen[r.prioridad as keyof typeof resumen] = Number(r.cantidad);
    });

    res.json({
      ok: true,
      items,
      resumen,
      pagination: {
        total:  countRows[0]?.total ?? 0,
        page:   parseInt(page),
        limit:  parseInt(limit),
      },
    });
  })
);

// POST /api/v1/compras/pre-orden
// Guarda una pre-orden con los productos y cantidades seleccionados
router.post("/compras/pre-orden", requireAuth, requireRole(["admin", "gerente"]),
  asyncHandler(async (req, res) => {
    const { sucursal_id, items, notas } = req.body as {
      sucursal_id?: string;
      notas?: string;
      items: { sku: string; cantidad: number; precio_unitario?: number }[];
    };

    if (!items?.length) throw new HttpError(400, "items requeridos");

    // Calcular total
    const total = items.reduce((acc, i) => acc + i.cantidad * (i.precio_unitario ?? 0), 0);

    const [orden] = await query<{ id: string }>(
      `INSERT INTO ordenes_compra
         (sucursal_id, estado, total, notas, creado_por, items)
       VALUES ($1, 'borrador', $2, $3, $4, $5)
       RETURNING id`,
      [
        sucursal_id ?? null,
        total,
        notas ?? null,
        req.user!.id,
        JSON.stringify(items),
      ]
    );

    logger.info({ orden_id: orden.id, items: items.length }, "compra.pre_orden.creada");

    res.status(201).json({ ok: true, orden_id: orden.id });
  })
);

// POST /api/v1/compras/recalcular — forzar recálculo (solo admin)
router.post("/compras/recalcular", requireAuth, requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    recalcularCompraSugerida()
      .then(r => logger.info(r, "compra_sugerida.recalculo_manual.done"))
      .catch(err => logger.error({ err }, "compra_sugerida.recalculo_manual.error"));

    res.json({ ok: true, message: "Recálculo iniciado en background" });
  })
);

export default router;
