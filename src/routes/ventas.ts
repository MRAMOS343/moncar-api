// src/routes/ventas.ts
import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { pool, withTransaction, query } from "../db";
import { BatchVentasSchema } from "../schemas/ventas";
import { requireAuth } from "../middleware/requireAuth";
import { requireAnyRole } from "../middleware/requireAnyRole";
import { logger } from "../logger";
import { cacheInvalidate } from "../utils/dbCache";

const router = Router();

/**
 * MODO SINGLE-STORE (temporal):
 * Forzamos que TODA la info quede ligada a esta sucursal.
 */
const FORCED_SUCURSAL_ID = process.env.FORCED_SUCURSAL_ID ?? "moncar";

/** Helpers */
function parseBool(v: unknown): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function parseCursorFecha(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseCursorVentaId(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * Construye un resumen de pagos en SQL (en GET /sales).
 * Formato: "EFE:100.00, TAR:250.00"
 * - agrupa por método y suma
 * - ordena por método
 */
const SQL_PAGOS_RESUMEN_LATERAL = `
LEFT JOIN LATERAL (
  SELECT
    string_agg(x.metodo || ':' || trim(to_char(x.monto, 'FM999999990.00')), ', ' ORDER BY x.metodo) AS pagos_resumen
  FROM (
    SELECT metodo, SUM(monto) AS monto
    FROM pagos_venta
    WHERE venta_id = v.venta_id
    GROUP BY metodo
  ) x
) pr ON true
`;

/**
 * POST /ventas/import-batch  (alias: /sales/import-batch)
 * Body: BatchVentasSchema (array de ventas)
 */
router.post(
  ["/ventas/import-batch", "/sales/import-batch"],
  requireAuth,
  requireAnyRole(["admin", "sync"]),
  async (req: Request, res: Response) => {
    logger.debug({ keys: Object.keys(req.body?.[0] ?? {}) }, "import-batch.sample_keys");
    logger.debug({
      id_venta: req.body?.[0]?.id_venta,
      cliente_origen: req.body?.[0]?.cliente_origen,
      datos_origen: req.body?.[0]?.datos_origen,
      estado_origen: req.body?.[0]?.estado_origen,
      usu_hora: req.body?.[0]?.usu_hora,
      usu_fecha: req.body?.[0]?.usu_fecha,
      no_referencia: req.body?.[0]?.no_referencia,
      caja: req.body?.[0]?.caja,
      serie: req.body?.[0]?.serie,
      folio: req.body?.[0]?.folio,
    }, "import-batch.sample_header");

    const parseResult = BatchVentasSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: parseResult.error.format(),
      });
    }

    const ventas = parseResult.data;
    if (ventas.length === 0) {
      return res.json({ ok: 0, dup: 0, error: 0, batch_id: null, errors: [] });
    }

    const batchId = randomUUID();

    // SOURCE_ID obligatorio
    const sourceId = process.env.SOURCE_ID;
    if (!sourceId) {
      return res.status(500).json({ ok: false, error: "SERVER_MISCONFIG_SOURCE_ID" });
    }

    let okCount = 0;
    let dupCount = 0;
    let errorCount = 0;
    const errorDetails: { id_venta: number; reason: string }[] = [];

    let maxIdVenta = 0;

    for (const venta of ventas) {
      maxIdVenta = Math.max(maxIdVenta, venta.id_venta);

      // total = subtotal + impuesto (acordado). Si tu payload trae "total" distinto, seguimos lo acordado.
      const subtotal = Number(venta.subtotal ?? 0);
      const impuesto = Number(venta.impuestos ?? venta.impuesto ?? 0);
      const total = subtotal + impuesto;

      // Mapeos robustos (compatibilidad)
      const cajaVal = venta.caja ?? venta.caja_id ?? null;

      const serieVal =
        venta.serie ??
        venta.serie_documento ??
        venta.serieDocumento ??
        null;

      const folioVal =
        venta.folio ??
        venta.folio_numero ??
        venta.folioNumero ??
        venta.no_referencia ??
        venta.NO_REFEREN ??
        null;

      const estadoVal = venta.estado_origen ?? venta.estado ?? null;
      const clienteVal = venta.cliente_origen ?? venta.cliente ?? null;
      const datosVal = venta.datos_origen ?? venta.datos ?? null;
      const usuFechaVal = venta.usu_fecha ?? null;
      const usuHoraVal = venta.usu_hora ?? null;

      const noRefVal =
        venta.no_referencia ??
        venta.NO_REFEREN ??
        venta.folio ??
        venta.folio_numero ??
        null;

      // Log de mapeo (temporal, útil para confirmar que no se pierden)
      logger.debug({
        id_venta: venta.id_venta,
        cajaVal,
        serieVal,
        folioVal,
        estadoVal,
        usuFechaVal,
        usuHoraVal,
        noRefVal,
      }, "import-batch.mapped_header");

      try {
        await withTransaction(async (client) => {
          // Encabezado (UPSERT)
          await client.query(
            `
            INSERT INTO ventas (
              venta_id,
              fecha_emision,
              sucursal_id,
              caja_id,
              serie_documento,
              folio_numero,
              no_referencia,
              cliente_origen,
              datos_origen,
              estado_origen,
              usu_fecha,
              usu_hora,
              subtotal,
              impuesto,
              total
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
            )
            ON CONFLICT (venta_id) DO UPDATE SET
              fecha_emision     = EXCLUDED.fecha_emision,
              sucursal_id       = EXCLUDED.sucursal_id,
              caja_id           = EXCLUDED.caja_id,
              serie_documento   = EXCLUDED.serie_documento,
              folio_numero      = EXCLUDED.folio_numero,
              no_referencia     = EXCLUDED.no_referencia,
              cliente_origen    = EXCLUDED.cliente_origen,
              datos_origen      = EXCLUDED.datos_origen,
              estado_origen     = EXCLUDED.estado_origen,
              usu_fecha         = EXCLUDED.usu_fecha,
              usu_hora          = EXCLUDED.usu_hora,
              subtotal          = EXCLUDED.subtotal,
              impuesto          = EXCLUDED.impuesto,
              total             = EXCLUDED.total,
              actualizado_en    = now()
            `,
            [
              venta.id_venta,
              venta.fecha_emision,
              FORCED_SUCURSAL_ID,

              cajaVal,
              serieVal,
              folioVal,
              noRefVal,

              clienteVal,
              datosVal,
              estadoVal,
              usuFechaVal,
              usuHoraVal,

              subtotal,
              impuesto,
              total,
            ]
          );

          // Líneas (reemplazo total idempotente)
          await client.query("DELETE FROM lineas_venta WHERE venta_id = $1", [venta.id_venta]);

          for (const [idx, linea] of (venta.lineas ?? []).entries()) {
            const renglon = idx + 1;

            const cantidad = Number(linea.cantidad ?? 0);
            const precioUnitario = Number(linea.precio ?? linea.precio_unitario ?? 0);
            const descuento = Number(linea.descuento ?? 0);

            // Persistimos el valor recibido (tasa o monto); después lo normalizas si quieres.
            const impuestoLinea = Number(linea.impuesto ?? linea.impuesto_linea ?? 0);

            const importeLinea =
              linea.importe != null
                ? Number(linea.importe)
                : Number.isFinite(cantidad) && Number.isFinite(precioUnitario)
                ? cantidad * precioUnitario - descuento
                : 0;

            const almacenId = linea.almacen_id ?? linea.almacen ?? null;

            const observOrigen = linea.observ ?? linea.observ_origen ?? null;
            const usuarioOrigen = linea.usuario ?? linea.usuario_origen ?? null;
            const lineaUsuHora = linea.usuhora ?? linea.usu_hora ?? null;
            const lineaUsuFecha = linea.usu_fecha ?? null;

            const idSalidaOrigen = linea.id_salida ?? linea.id_salida_origen ?? null;
            const estadoLinea = linea.estado ?? linea.estado_linea ?? null;

            await client.query(
              `
              INSERT INTO lineas_venta(
                venta_id,
                renglon,
                articulo,
                cantidad,
                precio_unitario,
                descuento,
                impuesto_linea,
                importe_linea,
                almacen_id,
                id_salida_origen,
                estado_linea,
                observ_origen,
                usuario_origen,
                usu_hora,
                usu_fecha
              ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
              )
              `,
              [
                venta.id_venta,
                renglon,
                linea.articulo,
                cantidad,
                precioUnitario,
                descuento,
                impuestoLinea,
                importeLinea,
                almacenId,
                idSalidaOrigen,
                estadoLinea,
                observOrigen,
                usuarioOrigen,
                lineaUsuHora,
                lineaUsuFecha,
              ]
            );
          }

          // Pagos (reemplazo total idempotente)
          await client.query("DELETE FROM pagos_venta WHERE venta_id = $1", [venta.id_venta]);

          for (const pago of venta.pagos ?? []) {
            await client.query(
              `
              INSERT INTO pagos_venta(
                venta_id,
                idx,
                metodo,
                monto
              ) VALUES (
                $1,$2,$3,$4
              )
              `,
              [venta.id_venta, Number(pago.idx), String(pago.metodo), Number(pago.monto)]
            );
          }
        });

        okCount++;
      } catch (e) {
        errorCount++;
        const reason = e instanceof Error ? e.message : "Error desconocido";
        errorDetails.push({ id_venta: venta.id_venta, reason });
        logger.error({ id_venta: venta.id_venta, reason }, "ventas.import-batch.procesando");
      }
    }

    // import_log
    try {
      await pool.query(
        `
        INSERT INTO import_log(
          batch_id,
          source_id,
          items,
          ok,
          dup,
          error,
          details
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7
        )
        `,
        [batchId, sourceId, ventas.length, okCount, dupCount, errorCount, JSON.stringify(errorDetails)]
      );
    } catch (e) {
      logger.error({ err: e }, "ventas.import-batch.import_log");
    }

    // estado_sincronizacion
    if (maxIdVenta > 0) {
      try {
        await pool.query(
          `
          INSERT INTO estado_sincronizacion(
            id_fuente,
            ultimo_id_venta
          ) VALUES (
            $1,$2
          )
          ON CONFLICT (id_fuente) DO UPDATE SET
            ultimo_id_venta = GREATEST(estado_sincronizacion.ultimo_id_venta, EXCLUDED.ultimo_id_venta),
            updated_at      = now()
          `,
          [sourceId, maxIdVenta]
        );
      } catch (e) {
        logger.error({ err: e }, "ventas.import-batch.estado_sincronizacion");
      }
    }

    if (okCount > 0) {
      await Promise.all([
        cacheInvalidate("kpis:"),
        cacheInvalidate("tendencia:"),
        cacheInvalidate("metodos_pago:"),
        cacheInvalidate("top_productos:"),
      ]);
    }

    return res.json({ ok: okCount, dup: dupCount, error: errorCount, batch_id: batchId, errors: errorDetails });
  }
);

/**
 * GET /ventas  (alias: /sales)
 * Devuelve: venta_id, sucursal_id, folio_numero, subtotal, impuesto, total,
 *          estado_origen, pagos_resumen, datos_origen, usu_fecha, usu_hora
 */
router.get(["/ventas", "/sales"], requireAuth, async (req: Request, res: Response) => {
  try {
    const sinceDate = String(req.query.from ?? "2025-01-01");

    const pageSizeRaw = req.query.limit ? Number(req.query.limit) : 50;
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(pageSizeRaw, 1), 100) : 50;

    const includeCancelled = parseBool(req.query.include_cancelled);

    // Forzado (single-store)
    const sucursalId = FORCED_SUCURSAL_ID;

    // Cursor compuesto
    const cursorFechaIso = parseCursorFecha(req.query.cursor_fecha);
    const cursorVentaId = parseCursorVentaId(req.query.cursor_venta_id);

    if ((cursorFechaIso && cursorVentaId == null) || (!cursorFechaIso && cursorVentaId != null)) {
      return res.status(400).json({
        ok: false,
        error: "CURSOR_INVALIDO",
        hint: "Debes enviar cursor_fecha y cursor_venta_id juntos.",
      });
    }

    const rows = await query<{
      venta_id: number;
      fecha_emision: string;
      sucursal_id: string | null;
      folio_numero: string | null;

      subtotal: string;
      impuesto: string;
      total: string;

      estado_origen: string | null;
      pagos_resumen: string | null;
      datos_origen: string | null;
      usu_fecha: string | null;
      usu_hora: string | null;

      cancelada: boolean;
    }>(
      `
      SELECT
        v.venta_id,
        v.fecha_emision,
        v.sucursal_id,
        v.folio_numero,

        v.subtotal::text AS subtotal,
        v.impuesto::text AS impuesto,
        v.total::text    AS total,

        v.estado_origen,
        pr.pagos_resumen,
        v.datos_origen,
        v.usu_fecha,
        v.usu_hora,

        v.cancelada
      FROM ventas v
      ${SQL_PAGOS_RESUMEN_LATERAL}
      WHERE v.fecha_emision >= $1::timestamptz
        AND v.sucursal_id = $2::text
        AND ($3::boolean = true OR v.cancelada = false)
        AND (
          $4::timestamptz IS NULL
          OR (v.fecha_emision, v.venta_id) < ($4::timestamptz, $5::bigint)
        )
      ORDER BY v.fecha_emision DESC, v.venta_id DESC
      LIMIT $6
      `,
      [sinceDate, sucursalId, includeCancelled, cursorFechaIso, cursorVentaId ?? 0, pageSize]
    );

    const hasNext = rows.length === pageSize;
    const last = hasNext ? rows[rows.length - 1] : null;

    return res.json({
      ok: true,
      items: rows,
      next_cursor: hasNext
        ? { cursor_fecha: new Date(last!.fecha_emision).toISOString(), cursor_venta_id: last!.venta_id }
        : null,
    });
  } catch (error) {
    logger.error({ err: error }, "ventas.list.error");
    return res.status(500).json({ ok: false, error: "VENTAS_LIST_FAILED" });
  }
});

/**
 * GET /ventas/:venta_id  (alias: /sales/:venta_id)
 * Detalle: encabezado + líneas + pagos
 */
router.get(["/ventas/:venta_id", "/sales/:venta_id"], requireAuth, async (req: Request, res: Response) => {
  const ventaId = Number(req.params.venta_id);
  if (!Number.isFinite(ventaId)) {
    return res.status(400).json({ ok: false, error: "VENTA_ID_INVALIDO" });
  }

  try {
    const ventasRows = await query<{
      venta_id: number;
      fecha_emision: string;
      sucursal_id: string | null;
      caja_id: string | null;
      serie_documento: string | null;
      folio_numero: string | null;

      subtotal: string;
      impuesto: string;
      total: string;

      cancelada: boolean;
      fecha_cancelacion: string | null;
      motivo_cancelacion: string | null;
      folio_sustitucion: string | null;

      estado_origen: string | null;
      cliente_origen: string | null;
      datos_origen: string | null;
      usu_fecha: string | null;
      usu_hora: string | null;
      no_referencia: string | null;
    }>(
      `
      SELECT
        venta_id,
        fecha_emision,
        sucursal_id,
        caja_id,
        serie_documento,
        folio_numero,

        subtotal::text AS subtotal,
        impuesto::text AS impuesto,
        total::text    AS total,

        cancelada,
        fecha_cancelacion,
        motivo_cancelacion,
        folio_sustitucion,

        estado_origen,
        cliente_origen,
        datos_origen,
        usu_fecha,
        usu_hora,
        no_referencia
      FROM ventas
      WHERE venta_id = $1::bigint
        AND sucursal_id = $2::text
      LIMIT 1
      `,
      [ventaId, FORCED_SUCURSAL_ID]
    );

    if (ventasRows.length === 0) {
      return res.status(404).json({ ok: false, error: "VENTA_NO_ENCONTRADA" });
    }

    const venta = ventasRows[0];

    const lineas = await query<{
      venta_id: number;
      renglon: number;
      articulo: string;

      cantidad: string;
      precio_unitario: string;
      descuento: string;
      impuesto_linea: string;
      importe_linea: string;
      almacen_id: string | null;

      observ_origen: string | null;
      usuario_origen: string | null;
      usu_hora: string | null;
      usu_fecha: string | null;
    }>(
      `
      SELECT
        venta_id,
        renglon,
        articulo,
        cantidad::text        AS cantidad,
        precio_unitario::text AS precio_unitario,
        descuento::text       AS descuento,
        impuesto_linea::text  AS impuesto_linea,
        importe_linea::text   AS importe_linea,
        almacen_id,
        observ_origen,
        usuario_origen,
        usu_hora,
        usu_fecha
      FROM lineas_venta
      WHERE venta_id = $1::bigint
      ORDER BY renglon ASC
      `,
      [ventaId]
    );

    const pagos = await query<{
      venta_id: number;
      idx: number;
      metodo: string;
      monto: string;
    }>(
      `
      SELECT
        venta_id,
        idx,
        metodo,
        monto::text AS monto
      FROM pagos_venta
      WHERE venta_id = $1::bigint
      ORDER BY idx ASC
      `,
      [ventaId]
    );

    return res.json({ ok: true, venta, lineas, pagos });
  } catch (error) {
    logger.error({ err: error }, "ventas.detalle.error");
    return res.status(500).json({ ok: false, error: "VENTA_DETALLE_FAILED" });
  }
});

export default router;
