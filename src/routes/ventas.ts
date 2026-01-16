// src/routes/ventas.ts
import { Router } from "express";
import { randomUUID } from "crypto";
import { pool, withTransaction, query } from "../db";
import { BatchVentasSchema } from "../schemas/ventas";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function parseBool(v: unknown): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Importa un lote de ventas desde el POS.
 *
 * Rutas (equivalentes):
 *  - POST /ventas/import-batch
 *  - POST /sales/import-batch
 *
 * Body: BatchVentasSchema (array de ventas)
 * Respuesta:
 * {
 *   ok:    número de ventas procesadas (insert o update),
 *   dup:   (por ahora 0),
 *   error: número de ventas que fallaron dentro del lote,
 *   batch_id: uuid del registro en import_log,
 *   errors: [{ id_venta, reason }]
 * }
 */
router.post(["/ventas/import-batch", "/sales/import-batch"], async (req, res) => {
  // 1) Validación con Zod
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
    return res.json({
      ok: 0,
      dup: 0,
      error: 0,
      batch_id: null,
      errors: [],
    });
  }

  const batchId = randomUUID();
  const sourceId = "POS-MYBUSINESS"; // por ahora fijo

  let okCount = 0;
  let dupCount = 0;
  let errorCount = 0;
  const errorDetails: { id_venta: number; reason: string }[] = [];

  let maxIdVenta = 0;

  for (const venta of ventas) {
    maxIdVenta = Math.max(maxIdVenta, venta.id_venta);

    // Reglas de totales acordadas:
    // total = subtotal + impuesto (desde tabla ventas del POS)
    const subtotal = Number(venta.subtotal ?? 0);
    const impuesto = Number((venta as any).impuestos ?? (venta as any).impuesto ?? 0);
    const total = subtotal + impuesto;

    try {
      await withTransaction(async (client) => {
        // --- Encabezado de venta (UPSERT) ---
        await client.query(
          `
          INSERT INTO ventas (
            venta_id,
            fecha_emision,
            sucursal_id,
            caja_id,
            serie_documento,
            folio_numero,
            subtotal,
            impuesto,
            total
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9
          )
          ON CONFLICT (venta_id) DO UPDATE SET
            fecha_emision     = EXCLUDED.fecha_emision,
            sucursal_id       = EXCLUDED.sucursal_id,
            caja_id           = EXCLUDED.caja_id,
            serie_documento   = EXCLUDED.serie_documento,
            folio_numero      = EXCLUDED.folio_numero,
            subtotal          = EXCLUDED.subtotal,
            impuesto          = EXCLUDED.impuesto,
            total             = EXCLUDED.total,
            actualizado_en    = now()
          `,
          [
            venta.id_venta,
            venta.fecha_emision,               // schema -> fecha_emision
            (venta as any).sucursal ?? null,   // schema actual: sucursal
            (venta as any).caja ?? null,
            (venta as any).serie_documento ?? null, // si lo agregas luego en extractor
            (venta as any).folio_numero ?? null,
            subtotal,
            impuesto,
            total,
          ]
        );

        // --- Líneas (reemplazo total idempotente) ---
        await client.query("DELETE FROM lineas_venta WHERE venta_id = $1", [
          venta.id_venta,
        ]);

        for (const [idx, linea] of venta.lineas.entries()) {
          const renglon = idx + 1;

          const cantidad = Number(linea.cantidad ?? 0);
          const precioUnitario = Number((linea as any).precio ?? (linea as any).precio_unitario ?? 0);
          const descuento = Number(linea.descuento ?? 0);

          // si tu extractor trae impuesto por línea, úsalo; si no, 0
          const impuestoLinea = Number((linea as any).impuesto ?? (linea as any).impuesto_linea ?? 0);

          // importe_linea (MVP): cantidad*precio - descuento (sin impuesto)
          // (si tu POS ya trae "importe" por línea, úsalo en vez de recalcular)
          const importeLinea =
            (linea as any).importe != null
              ? Number((linea as any).importe)
              : cantidad * precioUnitario - descuento;

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
              estado_linea
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
            )
            `,
            [
              venta.id_venta,
              renglon,
              linea.articulo,                   // schema: articulo
              cantidad,
              precioUnitario,
              descuento,
              impuestoLinea,
              importeLinea,
              (linea as any).almacen ?? null,   // schema actual: almacen
              (linea as any).id_salida_origen ?? null,
              (linea as any).estado_linea ?? null,
            ]
          );
        }

        // --- Pagos (reemplazo total idempotente) ---
        await client.query("DELETE FROM pagos_venta WHERE venta_id = $1", [
          venta.id_venta,
        ]);

        for (const pago of venta.pagos) {
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
            [
              venta.id_venta,
              (pago as any).idx,     // schema: idx
              (pago as any).metodo,
              (pago as any).monto,
            ]
          );
        }
      });

      okCount++;
    } catch (e) {
      errorCount++;
      const reason = e instanceof Error ? e.message : "Error desconocido";
      errorDetails.push({
        id_venta: venta.id_venta,
        reason,
      });
      console.error("[ventas.import-batch] error procesando venta", {
        id_venta: venta.id_venta,
        reason,
      });
    }
  }

  // --- Registrar lote en import_log ---
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
      [
        batchId,
        sourceId,
        ventas.length,
        okCount,
        dupCount,
        errorCount,
        JSON.stringify(errorDetails),
      ]
    );
  } catch (e) {
    console.error("[ventas.import-batch] error escribiendo import_log", e);
  }

  // --- Actualizar estado_sincronizacion ---
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
      console.error("[ventas.import-batch] error actualizando estado_sincronizacion", e);
    }
  }

  return res.json({
    ok: okCount,
    dup: dupCount,
    error: errorCount,
    batch_id: batchId,
    errors: errorDetails,
  });
});

/**
 * GET /ventas  (alias: /sales)
 * Listado paginado por cursor (venta_id), por defecto EXCLUYE canceladas.
 *
 * Query:
 *  - from=2025-01-01 (default)
 *  - cursor=venta_id (default 0)
 *  - limit (default 50, max 100)
 *  - sucursal_id (opcional)
 *  - include_cancelled=1|true (opcional)
 */
router.get(["/ventas", "/sales"], requireAuth, async (req, res) => {
  try {
    const sinceDate = String(req.query.from ?? "2025-01-01");
    const cursorId = req.query.cursor ? Number(req.query.cursor) : 0;
    const pageSizeRaw = req.query.limit ? Number(req.query.limit) : 50;
    const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(pageSizeRaw, 1), 100) : 50;

    const sucursalId = req.query.sucursal_id ? String(req.query.sucursal_id) : null;
    const includeCancelled = parseBool(req.query.include_cancelled);

    const rows = await query<{
      venta_id: number;
      fecha_emision: string;
      sucursal_id: string | null;
      caja_id: string | null;
      subtotal: string;
      impuesto: string;
      total: string;
      cancelada: boolean;
    }>(
      `
      SELECT
        venta_id,
        fecha_emision,
        sucursal_id,
        caja_id,
        subtotal::text AS subtotal,
        impuesto::text AS impuesto,
        total::text    AS total,
        cancelada
      FROM ventas
      WHERE fecha_emision >= $1::timestamptz
        AND venta_id > $2::bigint
        AND ($3::text IS NULL OR sucursal_id = $3::text)
        AND ($4::boolean = true OR cancelada = false)
      ORDER BY venta_id ASC
      LIMIT $5
      `,
      [sinceDate, cursorId, sucursalId, includeCancelled, pageSize]
    );

    const nextCursor = rows.length === pageSize ? rows[rows.length - 1].venta_id : null;

    return res.json({
      ok: true,
      items: rows,
      next_cursor: nextCursor,
    });
  } catch (error) {
    console.error("[GET /ventas] error:", error);
    return res.status(500).json({
      ok: false,
      error: "VENTAS_LIST_FAILED",
    });
  }
});

/**
 * GET /ventas/:venta_id  (alias: /sales/:venta_id)
 * Detalle: encabezado + líneas + pagos
 */
router.get(["/ventas/:venta_id", "/sales/:venta_id"], requireAuth, async (req, res) => {
  const ventaId = Number(req.params.venta_id);

  if (!Number.isFinite(ventaId)) {
    return res.status(400).json({
      ok: false,
      error: "VENTA_ID_INVALIDO",
    });
  }

  try {
    // Encabezado
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
        folio_sustitucion
      FROM ventas
      WHERE venta_id = $1::bigint
      LIMIT 1
      `,
      [ventaId]
    );

    if (ventasRows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "VENTA_NO_ENCONTRADA",
      });
    }

    const venta = ventasRows[0];

    // Líneas
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
        almacen_id
      FROM lineas_venta
      WHERE venta_id = $1::bigint
      ORDER BY renglon ASC
      `,
      [ventaId]
    );

    // Pagos
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

    return res.json({
      ok: true,
      venta,
      lineas,
      pagos,
    });
  } catch (error) {
    console.error("[GET /ventas/:venta_id] error:", error);
    return res.status(500).json({
      ok: false,
      error: "VENTA_DETALLE_FAILED",
    });
  }
});

export default router;
