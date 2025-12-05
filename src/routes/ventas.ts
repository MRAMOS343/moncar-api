// src/routes/ventas.ts
import { Router } from "express";
import { randomUUID } from "crypto";
import { pool, withTransaction } from "../db";
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

export default router;
