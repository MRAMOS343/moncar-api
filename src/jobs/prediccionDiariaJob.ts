import cron from "node-cron";
import { query } from "../db";
import { logger } from "../logger";
import {
  calcularPrediccionDiaria,
  calcularMAEDiario,
  calcularMAPEDiario
} from "../utils/prediccionDiaria";

const DIAS_HISTORIAL = 90;   // cuántos días hacia atrás analizar
const DIAS_ADELANTE  = 30;   // cuántos días hacia adelante predecir

export function startPrediccionDiariaJob() {
  // Lunes 7:30 PM hora Ciudad de México
  cron.schedule("30 19 * * 1", async () => {
    logger.info("prediccion_diaria.job.iniciando");
    try {
      const resultado = await recalcularPrediccionDiaria();
      logger.info(resultado, "prediccion_diaria.job.completado");
    } catch (err) {
      logger.error({ err }, "prediccion_diaria.job.error");
    }
  }, {
    timezone: "America/Mexico_City"
  });

  logger.info("prediccion_diaria.job.registrado (lunes 7:30pm CDMX)");
}

export async function recalcularPrediccionDiaria(): Promise<{
  sucursales: number;
  errores: number;
}> {
  // Obtener todas las sucursales con ventas recientes + null (todas juntas)
  const sucursalesRows = await query<{ sucursal_id: string | null }>(
    `SELECT DISTINCT sucursal_id
     FROM ventas
     WHERE usu_fecha >= CURRENT_DATE - INTERVAL '${DIAS_HISTORIAL} days'
       AND cancelada = false
     UNION ALL
     SELECT NULL AS sucursal_id`  // predicción global (todas las sucursales)
  );

  let procesadas = 0;
  let errores    = 0;

  for (const { sucursal_id } of sucursalesRows) {
    try {
      await procesarSucursal(sucursal_id);
      procesadas++;
    } catch (err) {
      errores++;
      logger.error({ err, sucursal_id }, "prediccion_diaria.error_sucursal");
    }
  }

  // Actualizar montos reales de días pasados
  await actualizarRealesDiarios();

  // Recalcular métricas
  await actualizarMetricasDiarias();

  return { sucursales: procesadas, errores };
}

async function procesarSucursal(sucursal_id: string | null): Promise<void> {
  // Historial de ventas diarias — usu_fecha ya es date en tu schema
  const historialRows = await query<{
    fecha: string;
    monto: string;
    dia_semana: number;
  }>(
    `SELECT
       usu_fecha::text                                    AS fecha,
       SUM(total)::numeric                               AS monto,
       EXTRACT(DOW FROM usu_fecha)::integer              AS dia_semana
     FROM ventas
     WHERE
       usu_fecha >= CURRENT_DATE - INTERVAL '${DIAS_HISTORIAL} days'
       AND ($1::text IS NULL OR sucursal_id = $1)
       AND cancelada = false
     GROUP BY usu_fecha
     ORDER BY usu_fecha ASC`,
    [sucursal_id]
  );

  if (historialRows.length < 7) return; // mínimo 1 semana de datos

  const historial = historialRows.map(h => ({
    fecha:      h.fecha,
    monto:      Number(h.monto),
    dia_semana: h.dia_semana,
  }));

  const predicciones = calcularPrediccionDiaria(historial, DIAS_ADELANTE);
  if (!predicciones.length) return;

  // UPSERT en cache
  for (const pred of predicciones) {
    await query(
      `INSERT INTO prediccion_diaria_cache
         (sucursal_id, fecha, monto_pred, tendencia, confianza, dia_semana)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (fecha, COALESCE(sucursal_id, ''))
       DO UPDATE SET
         monto_pred   = EXCLUDED.monto_pred,
         tendencia    = EXCLUDED.tendencia,
         confianza    = EXCLUDED.confianza,
         calculado_en = now()`,
      [sucursal_id, pred.fecha, pred.monto_pred, pred.tendencia, pred.confianza, pred.dia_semana]
    );
  }
}

async function actualizarRealesDiarios(): Promise<void> {
  // Rellenar monto_real en fechas que ya pasaron
  await query(
    `UPDATE prediccion_diaria_cache pc
     SET monto_real = (
       SELECT COALESCE(SUM(v.total), 0)
       FROM ventas v
       WHERE
         v.usu_fecha = pc.fecha
         AND (v.sucursal_id = pc.sucursal_id OR pc.sucursal_id IS NULL)
         AND v.cancelada = false
     )
     WHERE
       pc.fecha < CURRENT_DATE
       AND pc.monto_real IS NULL`
  );
}

async function actualizarMetricasDiarias(): Promise<void> {
  await query(
    `INSERT INTO prediccion_diaria_metricas (sucursal_id, mae, mape, dias_data)
     SELECT
       sucursal_id,
       AVG(ABS(monto_pred - monto_real))            AS mae,
       AVG(
         CASE WHEN monto_real > 0
         THEN ABS(monto_pred - monto_real) / monto_real * 100
         ELSE NULL END
       )                                             AS mape,
       COUNT(*)                                      AS dias_data
     FROM prediccion_diaria_cache
     WHERE
       monto_real IS NOT NULL
       AND fecha >= CURRENT_DATE - INTERVAL '60 days'
     GROUP BY sucursal_id
     ON CONFLICT (COALESCE(sucursal_id, ''))
     DO UPDATE SET
       mae          = EXCLUDED.mae,
       mape         = EXCLUDED.mape,
       dias_data    = EXCLUDED.dias_data,
       calculado_en = now()`
  );
}
