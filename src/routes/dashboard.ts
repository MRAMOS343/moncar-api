import { Router } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { asyncHandler } from "../utils/http";
import { cacheGet, cacheSet } from "../utils/dbCache";

const router = Router();

function buildKey(tipo: string, sucursal: string | null, extras = ""): string {
  return `${tipo}:${sucursal ?? "todas"}${extras ? `:${extras}` : ""}`;
}

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

// GET /api/v1/dashboard/kpis
router.get(
  "/dashboard/kpis",
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      sucursal_id,
      desde = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
      hasta = new Date().toISOString().split("T")[0],
    } = req.query as Record<string, string>;

    const key = buildKey("kpis", sucursal_id ?? null, `${desde}:${hasta}`);

    const cached = await cacheGet<Record<string, number>>(key);
    if (cached) {
      return res.json({ ok: true, ...cached, from_cache: true });
    }

    const params: any[] = [desde, hasta];
    const sf = sucursal_id ? `AND sucursal_id = $${params.push(sucursal_id)}` : "";

    const [kpis] = await query<{
      ventas_totales: string;
      num_transacciones: string;
      ticket_promedio: string;
      ventas_canceladas: string;
    }>(
      `SELECT
         COALESCE(SUM(total), 0)::numeric AS ventas_totales,
         COUNT(*)::integer                AS num_transacciones,
         COALESCE(AVG(total), 0)::numeric AS ticket_promedio,
         0::integer                       AS ventas_canceladas
       FROM ventas
       WHERE usu_fecha BETWEEN $1 AND $2
         AND estado_origen = 'CO'
         ${sf}`,
      params
    );

    const resultado = {
      ventas_totales: toNumber(kpis?.ventas_totales),
      num_transacciones: toNumber(kpis?.num_transacciones),
      ticket_promedio: toNumber(kpis?.ticket_promedio),
      ventas_canceladas: toNumber(kpis?.ventas_canceladas),
    };

    await cacheSet(key, "kpis", resultado);
    res.json({ ok: true, ...resultado, from_cache: false });
  })
);

// GET /api/v1/dashboard/tendencia
router.get(
  "/dashboard/tendencia",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { sucursal_id, dias = "15" } = req.query as Record<string, string>;
    const diasNum = Math.max(1, Math.min(365, Number.parseInt(dias, 10) || 15));
    const key = buildKey("tendencia", sucursal_id ?? null, String(diasNum));

    const cached = await cacheGet<object[]>(key);
    if (cached) {
      return res.json({ ok: true, data: cached, from_cache: true });
    }

    const params: any[] = [diasNum];
    const sf = sucursal_id ? `AND sucursal_id = $${params.push(sucursal_id)}` : "";

    const data = await query(
      `SELECT
         usu_fecha::text     AS fecha,
         SUM(total)::numeric AS total,
         COUNT(*)::integer   AS num_ventas
       FROM ventas
       WHERE
         usu_fecha >= CURRENT_DATE - ($1 * INTERVAL '1 day')
         AND estado_origen = 'CO'
         ${sf}
       GROUP BY usu_fecha
       ORDER BY usu_fecha ASC`,
      params
    );

    await cacheSet(key, "tendencia", data);
    res.json({ ok: true, data, from_cache: false });
  })
);

// GET /api/v1/dashboard/metodos-pago
router.get(
  "/dashboard/metodos-pago",
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      sucursal_id,
      desde = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
      hasta = new Date().toISOString().split("T")[0],
    } = req.query as Record<string, string>;

    const key = buildKey("metodos_pago", sucursal_id ?? null, `${desde}:${hasta}`);

    const cached = await cacheGet<object[]>(key);
    if (cached) {
      return res.json({ ok: true, data: cached, from_cache: true });
    }

    const params: any[] = [desde, hasta];
    const sf = sucursal_id ? `AND v.sucursal_id = $${params.push(sucursal_id)}` : "";

    const data = await query(
      `SELECT
         p.metodo,
         SUM(p.monto)::numeric AS total,
         COUNT(*)::integer     AS num_pagos,
         ROUND(
           SUM(p.monto) * 100.0 / NULLIF(SUM(SUM(p.monto)) OVER (), 0),
           1
         )::numeric            AS porcentaje
       FROM pagos_venta p
       JOIN ventas v ON v.venta_id = p.venta_id
       WHERE
         v.usu_fecha BETWEEN $1 AND $2
         AND v.estado_origen = 'CO'
         ${sf}
       GROUP BY p.metodo
       ORDER BY total DESC`,
      params
    );

    await cacheSet(key, "metodos_pago", data);
    res.json({ ok: true, data, from_cache: false });
  })
);

// GET /api/v1/dashboard/top-productos
router.get(
  "/dashboard/top-productos",
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      sucursal_id,
      desde = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0],
      hasta = new Date().toISOString().split("T")[0],
      limite = "10",
    } = req.query as Record<string, string>;

    const limiteNum = Math.max(1, Math.min(100, Number.parseInt(limite, 10) || 10));
    const key = buildKey("top_productos", sucursal_id ?? null, `${desde}:${hasta}:${limiteNum}`);

    const cached = await cacheGet<object[]>(key);
    if (cached) {
      return res.json({ ok: true, data: cached, from_cache: true });
    }

    const params: any[] = [desde, hasta, limiteNum];
    const sf = sucursal_id ? `AND v.sucursal_id = $${params.push(sucursal_id)}` : "";

    const data = await query(
      `SELECT
         lv.articulo                          AS sku,
         p.descrip                            AS nombre,
         p.marca,
         SUM(lv.cantidad)::numeric            AS unidades_vendidas,
         SUM(lv.importe_linea)::numeric       AS ingresos_totales,
         COUNT(DISTINCT lv.venta_id)::integer AS num_ventas
       FROM lineas_venta lv
       JOIN ventas v ON v.venta_id = lv.venta_id
       LEFT JOIN productos p ON p.sku = lv.articulo
       WHERE
         v.usu_fecha BETWEEN $1 AND $2
         AND v.estado_origen = 'CO'
         AND lv.articulo IS NOT NULL
         ${sf}
       GROUP BY lv.articulo, p.descrip, p.marca
       ORDER BY ingresos_totales DESC
       LIMIT $3`,
      params
    );

    await cacheSet(key, "top_productos", data);
    res.json({ ok: true, data, from_cache: false });
  })
);

export default router;
