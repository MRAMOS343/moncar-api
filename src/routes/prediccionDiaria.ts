import { Router } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler } from "../utils/http";
import { logger } from "../logger";
import { recalcularPrediccionDiaria } from "../jobs/prediccionDiariaJob";

const router = Router();

// GET /api/v1/prediccion/diaria
// vista = 'semanal' (default) | 'diaria'
router.get("/prediccion/diaria", requireAuth,
  asyncHandler(async (req, res) => {
    const {
      sucursal_id,
      horizonte = "12",   // semanas si vista=semanal, días si vista=diaria
      vista = "semanal",
    } = req.query as Record<string, string>;

    const limite = Math.min(
      vista === "semanal" ? 24 : 60,
      Math.max(1, parseInt(horizonte))
    );

    // ── Vista SEMANAL ────────────────────────────────────────────────────────
    if (vista === "semanal") {

      const [prediccionesSem, historialSem, metricas] = await Promise.all([

        // Predicciones agrupadas por semana
        query(
          `SELECT
             DATE_TRUNC('week', fecha)::date          AS semana_inicio,
             (DATE_TRUNC('week', fecha) + INTERVAL '6 days')::date AS semana_fin,
             SUM(monto_pred)::numeric                 AS monto_pred,
             SUM(monto_real)::numeric                 AS monto_real,
             AVG(confianza)::numeric                  AS confianza,
             MAX(tendencia)                           AS tendencia
           FROM prediccion_diaria_cache
           WHERE
             fecha >= DATE_TRUNC('week', CURRENT_DATE)
             AND fecha < DATE_TRUNC('week', CURRENT_DATE) + ($1 * INTERVAL '1 week')
             AND (sucursal_id = $2 OR ($2 IS NULL AND sucursal_id IS NULL))
           GROUP BY DATE_TRUNC('week', fecha)
           ORDER BY semana_inicio ASC`,
          [limite, sucursal_id ?? null]
        ),

        // Historial semanal real (últimas 16 semanas)
        query(
          `SELECT
             DATE_TRUNC('week', usu_fecha)::date      AS semana_inicio,
             (DATE_TRUNC('week', usu_fecha) + INTERVAL '6 days')::date AS semana_fin,
             SUM(total)::numeric                      AS monto,
             COUNT(*)::integer                        AS num_ventas,
             AVG(total)::numeric                      AS ticket_promedio
           FROM ventas
           WHERE
             usu_fecha >= CURRENT_DATE - INTERVAL '16 weeks'
             AND ($1::text IS NULL OR sucursal_id = $1)
             AND cancelada = false
           GROUP BY DATE_TRUNC('week', usu_fecha)
           ORDER BY semana_inicio ASC`,
          [sucursal_id ?? null]
        ),

        // Métricas (mismas para ambas vistas)
        query(
          `SELECT mae, mape, dias_data, calculado_en
           FROM prediccion_diaria_metricas
           WHERE (sucursal_id = $1 OR ($1 IS NULL AND sucursal_id IS NULL))`,
          [sucursal_id ?? null]
        ),
      ]);

      // KPIs
      const montosHist  = historialSem.map((h: any) => Number(h.monto));
      const promedioSem = montosHist.length
        ? montosHist.reduce((a: number, b: number) => a + b, 0) / montosHist.length
        : 0;
      const totalPred12 = prediccionesSem
        .slice(0, 12)
        .reduce((acc: number, p: any) => acc + Number(p.monto_pred), 0);

      return res.json({
        ok: true,
        vista: "semanal",
        historial:    historialSem,
        predicciones: prediccionesSem,
        metricas:     (metricas as any[])[0] ?? null,
        sin_datos:    prediccionesSem.length === 0,
        calculado_en: (prediccionesSem as any[])[0]?.calculado_en ?? null,
        kpis: {
          promedio_semanal:  Math.round(promedioSem * 100) / 100,
          total_pred_12sem:  Math.round(totalPred12 * 100) / 100,
          tendencia:         (prediccionesSem as any[])[0]?.tendencia ?? null,
          confianza:         (prediccionesSem as any[])[0]?.confianza ?? null,
        },
      });
    }

    // ── Vista DIARIA ─────────────────────────────────────────────────────────
    const [prediccionesDia, historialDia, metricas] = await Promise.all([

      query(
        `SELECT
           fecha,
           monto_pred,
           monto_real,
           tendencia,
           confianza,
           dia_semana
         FROM prediccion_diaria_cache
         WHERE
           fecha >= CURRENT_DATE
           AND fecha < CURRENT_DATE + ($1 * INTERVAL '1 day')
           AND (sucursal_id = $2 OR ($2 IS NULL AND sucursal_id IS NULL))
         ORDER BY fecha ASC`,
        [limite, sucursal_id ?? null]
      ),

      query(
        `SELECT
           usu_fecha::text                         AS fecha,
           SUM(total)::numeric                    AS monto,
           COUNT(*)::integer                      AS num_ventas,
           EXTRACT(DOW FROM usu_fecha)::integer   AS dia_semana
         FROM ventas
         WHERE
           usu_fecha >= CURRENT_DATE - INTERVAL '30 days'
           AND ($1::text IS NULL OR sucursal_id = $1)
           AND cancelada = false
         GROUP BY usu_fecha
         ORDER BY usu_fecha ASC`,
        [sucursal_id ?? null]
      ),

      query(
        `SELECT mae, mape, dias_data, calculado_en
         FROM prediccion_diaria_metricas
         WHERE (sucursal_id = $1 OR ($1 IS NULL AND sucursal_id IS NULL))`,
        [sucursal_id ?? null]
      ),
    ]);

    res.json({
      ok: true,
      vista: "diaria",
      historial:    historialDia,
      predicciones: prediccionesDia,
      metricas:     (metricas as any[])[0] ?? null,
      sin_datos:    prediccionesDia.length === 0,
      calculado_en: (prediccionesDia as any[])[0]?.calculado_en ?? null,
    });
  })
);

// POST /api/v1/prediccion/diaria/recalcular — solo admin
router.post("/prediccion/diaria/recalcular", requireAuth, requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    recalcularPrediccionDiaria()
      .then(r => logger.info(r, "prediccion_diaria.recalculo_manual.done"))
      .catch(err => logger.error({ err }, "prediccion_diaria.recalculo_manual.error"));

    res.json({ ok: true, message: "Recálculo iniciado en background" });
  })
);

export default router;
