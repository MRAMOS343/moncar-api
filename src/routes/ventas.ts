// src/routes/ventas.ts
import { Router } from "express";
import { randomUUID } from "crypto";
import { pool, withTransaction, query } from "../db"; // ← aquí añadimos query
import { BatchVentasSchema } from "../schemas/ventas";

const router = Router();


/**
 * Importa un lote de ventas desde el POS.
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
router.post("/ventas/import-batch", async (req, res) => {
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

    try {
      // TODO de UNA venta va dentro de una sola transacción
      await withTransaction(async (client) => {
        // --- Encabezado de venta ---
        await client.query(
          `
          INSERT INTO ventas (
            id_venta,
            fecha_hora_local,
            sucursal_pos,
            caja,
            folio_serie,
            folio_numero,
            subtotal,
            impuesto,
            total
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9
          )
          ON CONFLICT (id_venta) DO UPDATE SET
            fecha_hora_local = EXCLUDED.fecha_hora_local,
            sucursal_pos     = EXCLUDED.sucursal_pos,
            caja             = EXCLUDED.caja,
            folio_serie      = EXCLUDED.folio_serie,
            folio_numero     = EXCLUDED.folio_numero,
            subtotal         = EXCLUDED.subtotal,
            impuesto         = EXCLUDED.impuesto,
            total            = EXCLUDED.total,
            updated_at       = now()
        `,
          [
            venta.id_venta,
            venta.fecha_emision,                 // mapeo: fecha_emision -> fecha_hora_local
            (venta as any).sucursal ?? null,     // mapeo: sucursal -> sucursal_pos
            (venta as any).caja ?? null,
            null,                                // folio_serie (si luego la tienes, se mapea)
            null,                                // folio_numero
            venta.subtotal,
            venta.impuestos,                     // plural en schema -> impuesto en tabla
            venta.total,
          ]
        );

        // Log mínimo para depurar
        console.log("[ventas.import-batch] upsert venta", { id_venta: venta.id_venta });

        // --- Líneas de venta ---
        await client.query("DELETE FROM lineas_venta WHERE id_venta = $1", [
          venta.id_venta,
        ]);

        for (const [idx, linea] of venta.lineas.entries()) {
          const numeroLinea = idx + 1;
          const cantidad = linea.cantidad;
          const precioUnitario = linea.precio;
          const descuento = linea.descuento ?? 0;
          const totalLinea = cantidad * precioUnitario - descuento;

          await client.query(
            `
            INSERT INTO lineas_venta(
              id_venta,
              numero_linea,
              sku,
              cantidad,
              precio_unitario,
              descuento,
              total_linea,
              almacen_pos
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8
            )
          `,
            [
              venta.id_venta,
              numeroLinea,
              linea.articulo,                     // mapeo: articulo -> sku
              cantidad,
              precioUnitario,
              descuento,
              totalLinea,
              (linea as any).almacen ?? null,
            ]
          );
        }

        // --- Pagos ---
        await client.query("DELETE FROM pagos_venta WHERE id_venta = $1", [
          venta.id_venta,
        ]);

        for (const pago of venta.pagos) {
          await client.query(
            `
            INSERT INTO pagos_venta(
              id_venta,
              indice,
              metodo,
              monto
            ) VALUES (
              $1,$2,$3,$4
            )
          `,
            [
              venta.id_venta,
              pago.idx,          // tu schema real
              pago.metodo,
              pago.monto,
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
// Listado paginado de ventas
// Listado paginado de ventas
router.get("/ventas", async (req, res) => {
  try {
    const { from, cursor, limit } = req.query;

    // Fecha mínima (desde cuándo listar)
    const sinceDate = (from as string) ?? "2025-01-01";

    // Cursor por id_venta (para paginación)
    const cursorId = cursor ? Number(cursor) : 0;

    // Límite de filas por página
    const pageSize = limit ? Math.min(Number(limit), 100) : 50;

    const rows = await query<{
      id_venta: number;
      fecha_emision: string;
      sucursal: string | null;
      caja: string | null;
      subtotal: string;
      impuestos: string;
      total: string;
    }>(
      `
      SELECT
        id_venta,
        fecha_hora_local AS fecha_emision,
        sucursal_pos     AS sucursal,
        caja,
        subtotal::text   AS subtotal,
        impuesto::text   AS impuestos,
        total::text      AS total
      FROM ventas
      WHERE fecha_hora_local >= $1
        AND id_venta > $2
      ORDER BY id_venta
      LIMIT $3
      `,
      [sinceDate, cursorId, pageSize]
    );

    // Calcular next_cursor
    const nextCursor =
      rows.length === pageSize ? rows[rows.length - 1].id_venta : null;

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







// Detalle de una venta por id_venta





// Detalle de una venta por id_venta
router.get("/ventas/:id_venta", async (req, res) => {
  const idVenta = Number(req.params.id_venta);

  if (!Number.isFinite(idVenta)) {
    return res.status(400).json({
      ok: false,
      error: "ID_VENTA_INVALIDO",
    });
  }

  try {
    // Encabezado
    const ventasRows = await query<{
      id_venta: number;
      fecha_emision: string;
      sucursal: string | null;
      caja: string | null;
      subtotal: string;
      impuestos: string;
      total: string;
    }>(
      `
      SELECT
        id_venta,
        fecha_hora_local AS fecha_emision,
        sucursal_pos     AS sucursal,
        caja,
        subtotal::text   AS subtotal,
        impuesto::text   AS impuestos,
        total::text      AS total
      FROM ventas
      WHERE id_venta = $1
      `,
      [idVenta]
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
      id_venta: number;
      line_no: number;
      sku: string;
      cantidad: string;
      precio_unitario: string;
      descuento: string;
      total_linea: string;
      almacen: string | null;
    }>(
      `
      SELECT
        id_venta,
        numero_linea           AS line_no,
        sku,
        cantidad::text         AS cantidad,
        precio_unitario::text  AS precio_unitario,
        descuento::text        AS descuento,
        total_linea::text      AS total_linea,
        almacen_pos            AS almacen
      FROM lineas_venta
      WHERE id_venta = $1
      ORDER BY numero_linea
      `,
      [idVenta]
    );

    // Pagos
    const pagos = await query<{
      id_venta: number;
      idx: number;
      metodo: string;
      monto: string;
    }>(
      `
      SELECT
        id_venta,
        indice        AS idx,
        metodo,
        monto::text   AS monto
      FROM pagos_venta
      WHERE id_venta = $1
      ORDER BY indice
      `,
      [idVenta]
    );

    return res.json({
      ok: true,
      venta,
      lineas,
      pagos,
    });
  } catch (error) {
    console.error("[GET /ventas/:id_venta] error:", error);
    return res.status(500).json({
      ok: false,
      error: "VENTA_DETALLE_FAILED",
    });
  }
});
export default router;