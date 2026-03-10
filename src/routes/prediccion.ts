import { Router } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler, HttpError } from "../utils/http";
import { recalcularPredicciones } from "../jobs/prediccionJob";

const router = Router();

// GET /api/v1/prediccion
router.get("/prediccion", requireAuth,
  asyncHandler(async (req, res) => {
    const { producto_sku, sucursal_id, horizonte = "8" } = req.query as Record<string, string>;

    if (!producto_sku) throw new HttpError(400, "producto_sku requerido");
    const semanas = Math.min(12, Math.max(1, parseInt(horizonte)));

    const [predicciones, historial, metricas, producto, stockRows] = await Promise.all([

      // Predicciones del cache
      query(
        `SELECT semana_inicio, unidades_pred, unidades_reales, tendencia, confianza
         FROM prediccion_ventas_cache
         WHERE
           producto_sku = $1
           AND (sucursal_id = $2 OR ($2 IS NULL AND sucursal_id IS NULL))
           AND semana_inicio >= DATE_TRUNC('week', CURRENT_DATE)
         ORDER BY semana_inicio ASC
         LIMIT $3`,
        [producto_sku, sucursal_id ?? null, semanas]
      ),

      // Historial real — usu_fecha ya es date
      query(
        `SELECT
           DATE_TRUNC('week', v.usu_fecha)::date AS semana,
           SUM(lv.cantidad)::numeric             AS unidades
         FROM lineas_venta lv
         JOIN ventas v ON v.venta_id = lv.venta_id
         WHERE
           lv.articulo = $1
           AND ($2::text IS NULL OR v.sucursal_id = $2)
           AND v.usu_fecha >= CURRENT_DATE - INTERVAL '8 weeks'
           AND v.cancelada = false
         GROUP BY DATE_TRUNC('week', v.usu_fecha)
         ORDER BY semana ASC`,
        [producto_sku, sucursal_id ?? null]
      ),

      // Métricas MAE/MAPE
      query(
        `SELECT mae, mape, semanas_data, calculado_en
         FROM prediccion_metricas
         WHERE producto_sku = $1
           AND (sucursal_id = $2 OR ($2 IS NULL AND sucursal_id IS NULL))`,
        [producto_sku, sucursal_id ?? null]
      ),

      // Info del producto — columnas reales: descrip, precio1
      query(
        `SELECT
           sku,
           descrip   AS nombre,
           precio1   AS precio,
           marca,
           linea     AS categoria,
           minimo    AS stock_minimo
         FROM productos
         WHERE sku = $1`,
        [producto_sku]
      ),

      // Stock actual desde tabla inventario
      // Si sucursal_id aplica, filtrar por almacen
      query(
        `SELECT
           almacen,
           existencia
         FROM inventario
         WHERE sku = $1
         ORDER BY existencia DESC`,
        [producto_sku]
      ),
    ]);

    // Stock total o por sucursal
    const stockTotal = stockRows.reduce((acc, r) => acc + Number(r.existencia), 0);

    res.json({
      ok: true,
      producto: producto[0]
        ? { ...producto[0], stock_actual: stockTotal, stock_por_almacen: stockRows }
        : null,
      historial,
      predicciones,
      metricas:     metricas[0] ?? null,
      sin_datos:    predicciones.length === 0,
      calculado_en: predicciones[0]?.calculado_en ?? null,
    });
  })
);

// GET /api/v1/prediccion/productos
// Lista de productos con predicción disponible (para el dropdown del frontend)
router.get("/prediccion/productos", requireAuth,
  asyncHandler(async (req, res) => {
    const { sucursal_id } = req.query as Record<string, string>;

    const productos = await query(
      `SELECT DISTINCT
         pc.producto_sku                    AS sku,
         p.descrip                          AS nombre,
         p.marca,
         pm.mae,
         pm.mape,
         COALESCE(inv.stock_total, 0)       AS stock_actual
       FROM prediccion_ventas_cache pc
       LEFT JOIN productos p
         ON p.sku = pc.producto_sku
       LEFT JOIN prediccion_metricas pm
         ON pm.producto_sku = pc.producto_sku
         AND (pm.sucursal_id = $1 OR ($1 IS NULL AND pm.sucursal_id IS NULL))
       LEFT JOIN (
         SELECT sku, SUM(existencia) AS stock_total
         FROM inventario
         GROUP BY sku
       ) inv ON inv.sku = pc.producto_sku
       WHERE
         pc.semana_inicio >= DATE_TRUNC('week', CURRENT_DATE)
         AND ($1::text IS NULL OR pc.sucursal_id = $1)
       ORDER BY p.descrip ASC`,
      [sucursal_id ?? null]
    );

    res.json({ ok: true, productos });
  })
);

// POST /api/v1/prediccion/recalcular — forzar recálculo manual (solo admin)
router.post("/prediccion/recalcular", requireAuth, requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    recalcularPredicciones()
      .then(r => logger.info(r, "prediccion.recalculo_manual.done"))
      .catch(err => logger.error({ err }, "prediccion.recalculo_manual.error"));

    res.json({ ok: true, message: "Recálculo iniciado en background" });
  })
);

export default router;
