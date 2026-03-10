import cron from "node-cron";
import { query } from "../db";
import { logger } from "../logger";

const DIAS_HISTORIAL    = 90;
const DIAS_COBERTURA    = 30;  // cuántos días quieres cubrir con cada compra
const DIAS_REORDEN      = 14;  // si tienes menos de esto, es prioridad normal

export function startCompraSugeridaJob() {
  // Lunes 7:00 PM hora Ciudad de México (después del job de predicción)
  cron.schedule("0 19 * * 1", async () => {
    logger.info("compra_sugerida.job.iniciando");
    try {
      const resultado = await recalcularCompraSugerida();
      logger.info(resultado, "compra_sugerida.job.completado");
    } catch (err) {
      logger.error({ err }, "compra_sugerida.job.error");
    }
  }, {
    timezone: "America/Mexico_City"
  });

  logger.info("compra_sugerida.job.registrado (lunes 7pm CDMX)");
}

export async function recalcularCompraSugerida(): Promise<{
  productos: number;
  urgentes: number;
  errores: number;
}> {
  // Productos con movimiento en los últimos 90 días
  const productos = await query<{
    producto_sku: string;
    sucursal_id: string | null;
    unidades_vendidas: string;
  }>(
    `SELECT
       lv.articulo                  AS producto_sku,
       v.sucursal_id,
       SUM(lv.cantidad)::numeric    AS unidades_vendidas
     FROM lineas_venta lv
     JOIN ventas v ON v.venta_id = lv.venta_id
     WHERE
       v.usu_fecha >= CURRENT_DATE - INTERVAL '${DIAS_HISTORIAL} days'
       AND lv.articulo IS NOT NULL
       AND lv.articulo != ''
       AND v.cancelada = false
     GROUP BY lv.articulo, v.sucursal_id`
  );

  logger.info({ total: productos.length }, "compra_sugerida.productos_encontrados");

  let procesados = 0;
  let urgentes   = 0;
  let errores    = 0;

  for (const row of productos) {
    try {
      const resultado = await procesarProducto(
        row.producto_sku,
        row.sucursal_id,
        Number(row.unidades_vendidas)
      );
      if (resultado === "urgente") urgentes++;
      if (resultado !== null) procesados++;
    } catch (err) {
      errores++;
      logger.error({ err, sku: row.producto_sku }, "compra_sugerida.error_producto");
    }
  }

  return { productos: procesados, urgentes, errores };
}

async function procesarProducto(
  producto_sku: string,
  sucursal_id: string | null,
  unidades_vendidas_90d: number
): Promise<string | null> {

  // Stock actual desde inventario
  const stockRows = await query<{ existencia: string }>(
    `SELECT COALESCE(SUM(existencia), 0)::numeric AS existencia
     FROM inventario
     WHERE sku = $1
       AND ($2::text IS NULL OR almacen = $2)`,
    [producto_sku, sucursal_id]
  );
  const stock_actual = Number(stockRows[0]?.existencia ?? 0);

  // Info del producto (minimo, maximo)
  const productoRows = await query<{
    minimo: string | null;
    maximo: string | null;
  }>(
    `SELECT minimo, maximo FROM productos WHERE sku = $1`,
    [producto_sku]
  );
  const minimo = Number(productoRows[0]?.minimo ?? 0);

  // Cálculos
  const promedio_diario  = unidades_vendidas_90d / DIAS_HISTORIAL;
  const dias_cobertura   = promedio_diario > 0
    ? Math.round((stock_actual / promedio_diario) * 10) / 10
    : 999; // si no se vende, cobertura infinita

  const cantidad_sugerida = Math.max(
    0,
    Math.ceil((promedio_diario * DIAS_COBERTURA) - stock_actual)
  );

  // Determinar prioridad
  let prioridad: string | null = null;

  if (stock_actual <= minimo && minimo > 0) {
    prioridad = "urgente";
  } else if (dias_cobertura < DIAS_REORDEN) {
    prioridad = "normal";
  } else if (dias_cobertura < DIAS_COBERTURA) {
    prioridad = "opcional";
  }

  // Si tiene suficiente cobertura, eliminar del cache y no insertar
  if (prioridad === null) {
    await query(
      `DELETE FROM compra_sugerida_cache
       WHERE producto_sku = $1
         AND (sucursal_id = $2 OR ($2 IS NULL AND sucursal_id IS NULL))`,
      [producto_sku, sucursal_id]
    );
    return null;
  }

  // Guardar en cache
  await query(
    `INSERT INTO compra_sugerida_cache
       (producto_sku, sucursal_id, stock_actual, promedio_diario,
        dias_cobertura, cantidad_sugerida, prioridad)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (producto_sku, COALESCE(sucursal_id, ''))
     DO UPDATE SET
       stock_actual      = EXCLUDED.stock_actual,
       promedio_diario   = EXCLUDED.promedio_diario,
       dias_cobertura    = EXCLUDED.dias_cobertura,
       cantidad_sugerida = EXCLUDED.cantidad_sugerida,
       prioridad         = EXCLUDED.prioridad,
       calculado_en      = now()`,
    [
      producto_sku,
      sucursal_id,
      stock_actual,
      Math.round(promedio_diario * 10000) / 10000,
      dias_cobertura,
      cantidad_sugerida,
      prioridad,
    ]
  );

  return prioridad;
}
