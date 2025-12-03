// src/routes/ventas.ts
import { Router } from "express";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { BatchVentasSchema } from "../schemas/ventas";

const router = Router();

/**
 * Importa un lote de ventas desde el POS.
 *
 * Body: BatchVentasSchema (array de ventas)
 * Respuesta:
 * {
 *   ok:    número de ventas procesadas (insert o update),
 *   dup:   (por ahora 0, no distinguimos solo-duplicados),
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

  // Tu schema NO tiene source_id; usamos un identificador fijo por ahora
  const batchId = randomUUID();
  const sourceId = "POS-MYBUSINESS"; // si quieres luego lo sacamos de env

  let okCount = 0;
  let dupCount = 0;
  let errorCount = 0;
  const errorDetails: { id_venta: number; reason: string }[] = [];

  let maxIdVenta = 0;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const venta of ventas) {
      maxIdVenta = Math.max(maxIdVenta, venta.id_venta);

      try {
        // 2) UPSERT en tabla ventas
        // MAPEAMOS CAMPOS:
        // - fecha_emision (string) -> fecha_hora_local (TIMESTAMPTZ)
        // - sucursal -> sucursal_pos
        // - subtotal -> subtotal
        // - impuestos -> impuesto (singular)
        // - total -> total
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
            // tu schema tiene fecha_emision
            venta.fecha_emision,
            // TS te sugiere sucursal (no sucursal_pos)
            (venta as any).sucursal ?? null,
            // si tu schema tiene caja, la usamos; si no, null
            (venta as any).caja ?? null,
            // si tu schema tiene alguna columna de folio, luego la mapeamos; por ahora null
            null,
            null,
            venta.subtotal,
            venta.impuestos, // plural en el schema, singular en la columna
            venta.total,
          ]
        );

        okCount++;

        // 3) Reemplazar líneas de venta
        await client.query("DELETE FROM lineas_venta WHERE id_venta = $1", [
          venta.id_venta,
        ]);

        // Tu schema de línea: { articulo, cantidad, precio, ... }
        for (const [idx, linea] of venta.lineas.entries()) {
          const numeroLinea = idx + 1;

          const cantidad = linea.cantidad;
          const precioUnitario = linea.precio;
          const descuento = linea.descuento ?? 0;

          // Si no tienes un campo de total, lo calculamos sencillo:
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
              linea.articulo,        // articulo = sku
              cantidad,
              precioUnitario,
              descuento,
              totalLinea,
              // si tu schema tiene "almacen", luego lo mapeamos; por ahora null
              (linea as any).almacen ?? null,
            ]
          );
        }

        // 4) Reemplazar pagos de la venta
        await client.query("DELETE FROM pagos_venta WHERE id_venta = $1", [
          venta.id_venta,
        ]);

        // Tu schema de pago: { idx, metodo, monto }
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
              pago.idx,        // aquí antes usábamos pago.indice
              pago.metodo,
              pago.monto,
            ]
          );
        }
      } catch (e) {
        errorCount++;
        const reason = e instanceof Error ? e.message : "Error desconocido";
        errorDetails.push({
          id_venta: venta.id_venta,
          reason,
        });
        // seguimos con la siguiente venta (no tumbamos todo el lote)
      }
    }

    // 5) Registrar el lote en import_log
    await client.query(
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

    // 6) Actualizar estado_sincronizacion
    if (maxIdVenta > 0) {
      await client.query(
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
    }

    await client.query("COMMIT");

    return res.json({
      ok: okCount,
      dup: dupCount,
      error: errorCount,
      batch_id: batchId,
      errors: errorDetails,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[/ventas/import-batch] Error en lote:", e);
    return res.status(500).json({
      ok: false,
      error: "BATCH_FAILED",
    });
  } finally {
    client.release();
  }
});

export default router;

