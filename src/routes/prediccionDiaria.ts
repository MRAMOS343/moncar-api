import { Router } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler, HttpError } from "../utils/http";
import { logger } from "../logger";
import { recalcularPrediccionDiaria } from "../jobs/prediccionDiariaJob";

const router = Router();

type PrediccionSemanalRow = {
  semana_inicio: string;
  semana_fin: string;
  monto_pred: string;
  monto_real: string | null;
  confianza: string | null;
  tendencia: string | null;
  calculado_en: string;
};

type HistorialSemanalDiaRow = {
  semana_inicio: string;
  semana_fin: string;
  monto: string;
  num_ventas: number;
  dia_semana: number;
};

type MetricasPrediccionRow = {
  mae: string | null;
  mape: string | null;
  dias_data: number | null;
  calculado_en: string;
};

type PrediccionDiariaRow = {
  fecha: string;
  monto_pred: string;
  monto_real: string | null;
  tendencia: string | null;
  confianza: string | null;
  dia_semana: number;
  calculado_en?: string;
};

type HistorialDiarioRow = {
  fecha: string;
  monto: string;
  num_ventas: number;
  dia_semana: number;
};

type SemanaRealRow = {
  fecha: string;
  monto_real: string;
  num_ventas: number;
  dia_semana: number;
};

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
        query<PrediccionSemanalRow>(
          `SELECT
             DATE_TRUNC('week', fecha)::date                        AS semana_inicio,
             (DATE_TRUNC('week', fecha) + INTERVAL '6 days')::date AS semana_fin,
             SUM(monto_pred)::numeric                               AS monto_pred,
             SUM(monto_real)::numeric                               AS monto_real,
             AVG(confianza)::numeric                                AS confianza,
             MAX(tendencia)                                         AS tendencia,
             MAX(calculado_en)                                      AS calculado_en
           FROM prediccion_diaria_cache
           WHERE
             fecha >= DATE_TRUNC('week', CURRENT_DATE)
             AND fecha < DATE_TRUNC('week', CURRENT_DATE) + ($1 * INTERVAL '1 week')
             AND (sucursal_id = $2 OR ($2 IS NULL AND sucursal_id IS NULL))
           GROUP BY DATE_TRUNC('week', fecha)
           ORDER BY semana_inicio ASC`,
          [limite, sucursal_id ?? null]
        ),

        // Historial de las últimas 16 semanas con detalle por día de semana
        query<HistorialSemanalDiaRow>(
          `SELECT
             DATE_TRUNC('week', usu_fecha)::date                        AS semana_inicio,
             (DATE_TRUNC('week', usu_fecha) + INTERVAL '6 days')::date AS semana_fin,
             SUM(total)::numeric                                       AS monto,
             COUNT(*)::integer                                         AS num_ventas,
             EXTRACT(DOW FROM usu_fecha)::integer                      AS dia_semana
           FROM ventas
           WHERE
             usu_fecha >= CURRENT_DATE - INTERVAL '16 weeks'
             AND ($1::text IS NULL OR sucursal_id = $1)
             AND cancelada = false
           GROUP BY DATE_TRUNC('week', usu_fecha), usu_fecha
           ORDER BY semana_inicio ASC`,
          [sucursal_id ?? null]
        ),

        // Métricas (mismas para ambas vistas)
        query<MetricasPrediccionRow>(
          `SELECT mae, mape, dias_data, calculado_en
           FROM prediccion_diaria_metricas
           WHERE (sucursal_id = $1 OR ($1 IS NULL AND sucursal_id IS NULL))`,
          [sucursal_id ?? null]
        ),
      ]);

      // KPI: promedio semanal
      const semanasMapa = new Map<string, number>();
      for (const row of historialSem) {
        const key = row.semana_inicio;
        semanasMapa.set(key, (semanasMapa.get(key) ?? 0) + Number(row.monto));
      }
      const montosPorSemana = Array.from(semanasMapa.values());
      const promedioSemanal = montosPorSemana.length
        ? montosPorSemana.reduce((a, b) => a + b, 0) / montosPorSemana.length
        : 0;

      // KPI: tendencia vs mes anterior (últimas 4 semanas vs 4 anteriores)
      const ultimas4 = montosPorSemana.slice(-4);
      const anteriores4 = montosPorSemana.slice(-8, -4);
      const promUltimas4 = ultimas4.length
        ? ultimas4.reduce((a, b) => a + b, 0) / ultimas4.length
        : 0;
      const promAnteriores4 = anteriores4.length
        ? anteriores4.reduce((a, b) => a + b, 0) / anteriores4.length
        : 0;
      const cambioPct = promAnteriores4 > 0
        ? ((promUltimas4 - promAnteriores4) / promAnteriores4) * 100
        : 0;

      // KPI: mejor y peor día de la semana
      const promediosPorDia: Record<number, number[]> = {
        0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [],
      };
      for (const row of historialSem) {
        const dia = Number(row.dia_semana);
        if (Number.isInteger(dia) && dia >= 0 && dia <= 6) {
          promediosPorDia[dia].push(Number(row.monto));
        }
      }

      const NOMBRES_DIA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
      const promediosDia = Object.entries(promediosPorDia).map(([dia, montos]) => ({
        dia_semana: Number(dia),
        nombre: NOMBRES_DIA[Number(dia)],
        promedio: montos.length ? montos.reduce((a, b) => a + b, 0) / montos.length : 0,
      }));

      const diasConVentas = promediosDia.filter((d) => d.promedio > 0);
      const mejorDia = diasConVentas.length
        ? diasConVentas.reduce((a, b) => (a.promedio > b.promedio ? a : b))
        : null;
      const peorDia = diasConVentas.length
        ? diasConVentas.reduce((a, b) => (a.promedio < b.promedio ? a : b))
        : null;

      // KPI: total predicho próximas N semanas
      const totalPredProximas = prediccionesSem
        .reduce((acc, p) => acc + Number(p.monto_pred), 0);

      const primeraPred = prediccionesSem[0];
      const segundaPred = prediccionesSem[1];

      return res.json({
        ok: true,
        vista: "semanal",

        // Historial agrupado por semana (para gráfica)
        historial: Array.from(semanasMapa.entries()).map(([semana_inicio, monto]) => ({
          semana_inicio,
          monto,
        })),

        predicciones: prediccionesSem,

        // Detalle por día de semana (barras)
        promedio_por_dia: promediosDia,

        metricas: metricas[0] ?? null,
        sin_datos: prediccionesSem.length === 0,
        calculado_en: primeraPred?.calculado_en ?? null,
        kpis: {
          esta_semana: Number(primeraPred?.monto_pred ?? 0),
          proxima_semana: Number(segundaPred?.monto_pred ?? 0),
          tendencia: primeraPred?.tendencia ?? "estable",
          cambio_pct: Math.round(cambioPct * 10) / 10,
          mejor_dia: mejorDia,
          peor_dia: peorDia,
          promedio_semanal: Math.round(promedioSemanal * 100) / 100,
          total_pred_proximas: Math.round(totalPredProximas * 100) / 100,
        },
      });
    }

    // ── Vista DIARIA ─────────────────────────────────────────────────────────
    const [prediccionesDia, historialDia, metricas] = await Promise.all([

      query<PrediccionDiariaRow>(
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

      query<HistorialDiarioRow>(
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

      query<MetricasPrediccionRow>(
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
      metricas:     metricas[0] ?? null,
      sin_datos:    prediccionesDia.length === 0,
      calculado_en: prediccionesDia[0]?.calculado_en ?? null,
    });
  })
);

// GET /api/v1/prediccion/diaria/semana/:fecha
// :fecha = inicio de semana (YYYY-MM-DD)
router.get("/prediccion/diaria/semana/:fecha", requireAuth,
  asyncHandler(async (req, res) => {
    const fecha = String(req.params.fecha ?? "").trim();
    const { sucursal_id } = req.query as Record<string, string>;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      throw new HttpError(400, "BAD_REQUEST", "Formato de fecha inválido. Usar YYYY-MM-DD");
    }

    const [diasPrediccion, diasReal] = await Promise.all([
      query<PrediccionDiariaRow>(
        `SELECT
           fecha,
           monto_pred,
           monto_real,
           dia_semana,
           confianza
         FROM prediccion_diaria_cache
         WHERE
           fecha >= $1::date
           AND fecha < $1::date + INTERVAL '7 days'
           AND (sucursal_id = $2 OR ($2 IS NULL AND sucursal_id IS NULL))
         ORDER BY fecha ASC`,
        [fecha, sucursal_id ?? null]
      ),

      query<SemanaRealRow>(
        `SELECT
           usu_fecha::text                       AS fecha,
           SUM(total)::numeric                   AS monto_real,
           COUNT(*)::integer                     AS num_ventas,
           EXTRACT(DOW FROM usu_fecha)::integer  AS dia_semana
         FROM ventas
         WHERE
           usu_fecha >= $1::date
           AND usu_fecha < $1::date + INTERVAL '7 days'
           AND ($2::text IS NULL OR sucursal_id = $2)
           AND cancelada = false
         GROUP BY usu_fecha
         ORDER BY usu_fecha ASC`,
        [fecha, sucursal_id ?? null]
      ),
    ]);

    const NOMBRES_DIA = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const realPorFecha = new Map<string, SemanaRealRow>(diasReal.map((d) => [d.fecha, d]));

    const dias = diasPrediccion.map((d) => {
      const fechaDia = d.fecha;
      const real = realPorFecha.get(fechaDia);
      return {
        fecha: fechaDia,
        nombre_dia: NOMBRES_DIA[Number(d.dia_semana)] ?? "",
        dia_semana: Number(d.dia_semana),
        monto_pred: Number(d.monto_pred),
        monto_real: real ? Number(real.monto_real) : (d.monto_real != null ? Number(d.monto_real) : null),
        num_ventas: real ? Number(real.num_ventas) : null,
      };
    });

    const totalPred = dias.reduce((acc, d) => acc + d.monto_pred, 0);
    const totalReal = dias.every((d) => d.monto_real !== null)
      ? dias.reduce((acc, d) => acc + (d.monto_real ?? 0), 0)
      : null;

    res.json({
      ok: true,
      semana_inicio: fecha,
      semana_fin: dias[dias.length - 1]?.fecha ?? fecha,
      dias,
      total_pred: Math.round(totalPred * 100) / 100,
      total_real: totalReal !== null ? Math.round(totalReal * 100) / 100 : null,
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
