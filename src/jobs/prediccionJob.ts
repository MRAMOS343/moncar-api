import cron from "node-cron";
import { query, withTransaction } from "../db";
import { logger } from "../logger";
import { calcularPrediccion, calcularMAE, calcularMAPE } from "../utils/prediccion";

const HORIZONTE_SEMANAS = 8;

export function startPrediccionJob() {
  cron.schedule("0 3 * * 0", async () => {
    logger.info("prediccion.job.iniciando");
    try {
      const resultado = await recalcularPredicciones();
      logger.info(resultado, "prediccion.job.completado");
    } catch (err) {
      logger.error({ err }, "prediccion.job.error");
    }
  });

  logger.info("prediccion.job.registrado (domingos 3am)");
}

export async function recalcularPredicciones(): Promise<{
  productos: number;
  errores: number;
}> {
  // Tu columna en lineas_venta es `articulo` y en ventas es `sucursal_id` (text)
  const productos = await query<{ producto_sku: string; sucursal_id: string | null }>(
    `SELECT DISTINCT
       lv.articulo    AS producto_sku,
       v.sucursal_id
     FROM lineas_venta lv
     JOIN ventas v ON v.venta_id = lv.venta_id
     WHERE
       v.usu_fecha >= CURRENT_DATE - INTERVAL '90 days'
       AND lv.articulo IS NOT NULL
       AND lv.articulo != ''
       AND v.cancelada = false`
  );

  logger.info({ total: productos.length }, "prediccion.productos_a_procesar");

  let procesados = 0;
  let errores    = 0;

  for (const { producto_sku, sucursal_id } of productos) {
    try {
      await procesarProducto(producto_sku, sucursal_id);
      procesados++;
    } catch (err) {
      errores++;
      logger.error({ err, producto_sku, sucursal_id }, "prediccion.error_producto");
    }
  }

  await actualizarReales();
  await actualizarMetricas();

  return { productos: procesados, errores };
}

async function procesarProducto(
  producto_sku: string,
  sucursal_id: string | null
): Promise<void> {
  // usu_fecha ya es tipo date, no necesita cast
  const historial = await query<{ unidades: string }>(
    `SELECT
       SUM(lv.cantidad)::numeric AS unidades
     FROM lineas_venta lv
     JOIN ventas v ON v.venta_id = lv.venta_id
     WHERE
       lv.articulo = $1
       AND ($2::text IS NULL OR v.sucursal_id = $2)
       AND v.usu_fecha >= CURRENT_DATE - INTERVAL '16 weeks'
       AND v.cancelada = false
     GROUP BY DATE_TRUNC('week', v.usu_fecha)
     ORDER BY DATE_TRUNC('week', v.usu_fecha) DESC`,
    [producto_sku, sucursal_id]
  );

  const valores = historial.map(h => Number(h.unidades));
  if (valores.length < 2) return;

  const predicciones = calcularPrediccion(valores, HORIZONTE_SEMANAS);

  await withTransaction(async (client) => {
    for (const pred of predicciones) {
      await client.query(
        `INSERT INTO prediccion_ventas_cache
           (producto_sku, sucursal_id, semana_inicio, unidades_pred, tendencia, confianza)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (producto_sku, COALESCE(sucursal_id, ''), semana_inicio)
         DO UPDATE SET
           unidades_pred = EXCLUDED.unidades_pred,
           tendencia     = EXCLUDED.tendencia,
           confianza     = EXCLUDED.confianza,
           calculado_en  = now()`,
        [producto_sku, sucursal_id, pred.semana_inicio, pred.unidades_pred, pred.tendencia, pred.confianza]
      );
    }
  });
}

async function actualizarReales(): Promise<void> {
  // usu_fecha es date, no necesita ::date
  await query(
    `UPDATE prediccion_ventas_cache pc
     SET unidades_reales = (
       SELECT COALESCE(SUM(lv.cantidad), 0)
       FROM lineas_venta lv
       JOIN ventas v ON v.venta_id = lv.venta_id
       WHERE
         lv.articulo    = pc.producto_sku
         AND (v.sucursal_id = pc.sucursal_id OR pc.sucursal_id IS NULL)
         AND v.usu_fecha >= pc.semana_inicio
         AND v.usu_fecha <  pc.semana_inicio + INTERVAL '7 days'
         AND v.cancelada = false
     )
     WHERE
       pc.semana_inicio < CURRENT_DATE
       AND pc.unidades_reales IS NULL`
  );
}

async function actualizarMetricas(): Promise<void> {
  await query(
    `INSERT INTO prediccion_metricas (producto_sku, sucursal_id, mae, mape, semanas_data)
     SELECT
       producto_sku,
       sucursal_id,
       AVG(ABS(unidades_pred - unidades_reales))       AS mae,
       AVG(
         CASE WHEN unidades_reales > 0
         THEN ABS(unidades_pred - unidades_reales) / unidades_reales * 100
         ELSE NULL END
       )                                               AS mape,
       COUNT(*)                                        AS semanas_data
     FROM prediccion_ventas_cache
     WHERE
       unidades_reales IS NOT NULL
       AND semana_inicio >= CURRENT_DATE - INTERVAL '12 weeks'
     GROUP BY producto_sku, sucursal_id
     ON CONFLICT (producto_sku, COALESCE(sucursal_id, ''))
     DO UPDATE SET
       mae          = EXCLUDED.mae,
       mape         = EXCLUDED.mape,
       semanas_data = EXCLUDED.semanas_data,
       calculado_en = now()`
  );
}
