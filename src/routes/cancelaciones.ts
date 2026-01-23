// src/routes/cancelaciones.ts
import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { pool, withTransaction } from "../db";
import { BatchCancelacionesSchema } from "../schemas/cancelaciones";
import { requireAuth } from "../middleware/requireAuth";
import { requireAnyRole } from "../middleware/requireAnyRole";

const router = Router();

/**
 * MODO SINGLE-STORE (temporal):
 * Igual que ventas, si quieres validar ventas por sucursal.
 */
const FORCED_SUCURSAL_ID = process.env.FORCED_SUCURSAL_ID ?? "moncar";

/**
 * POST /cancelaciones/import-batch
 * (opcional alias /cancellations/import-batch)
 *
 * Body: BatchCancelacionesSchema (array)
 */
router.post(
  ["/cancelaciones/import-batch", "/cancellations/import-batch"],
  requireAuth,
  requireAnyRole(["admin", "sync"]),
  async (req: Request, res: Response) => {
    const parseResult = BatchCancelacionesSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        ok: false,
        error: "VALIDATION_ERROR",
        details: parseResult.error.format(),
      });
    }

    const items = parseResult.data;

    if (items.length === 0) {
      return res.json({
        ok: 0,
        dup: 0,
        error: 0,
        batch_id: null,
        errors: [],
      });
    }

    const batchId = randomUUID();

    // ✅ SOURCE_ID viene del .env del backend (obligatorio)
    const sourceId = process.env.SOURCE_ID;
    if (!sourceId) {
      return res.status(500).json({ ok: false, error: "SERVER_MISCONFIG_SOURCE_ID" });
    }

    let okCount = 0;
    let dupCount = 0; // no distinguimos aún (UPSERT idempotente)
    let errorCount = 0;
    const errors: { id_cancelacion_origen: number; reason: string }[] = [];

    let maxCancelId = 0;

    for (const c of items) {
      maxCancelId = Math.max(maxCancelId, c.id_cancelacion_origen);

      try {
        await withTransaction(async (client) => {
          // 1) UPSERT cancelación (idempotente por PK id_cancelacion_origen)
          await client.query(
            `
            INSERT INTO cancelaciones (
              id_cancelacion_origen,
              venta_id,
              fecha_emision,
              fecha_cancelacion,
              motivo_cancelacion,
              folio_sustitucion,
              uuid_cfdi
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7
            )
            ON CONFLICT (id_cancelacion_origen) DO UPDATE SET
              venta_id          = COALESCE(EXCLUDED.venta_id, cancelaciones.venta_id),
              fecha_emision     = COALESCE(EXCLUDED.fecha_emision, cancelaciones.fecha_emision),
              fecha_cancelacion = COALESCE(EXCLUDED.fecha_cancelacion, cancelaciones.fecha_cancelacion),
              motivo_cancelacion= COALESCE(EXCLUDED.motivo_cancelacion, cancelaciones.motivo_cancelacion),
              folio_sustitucion = COALESCE(EXCLUDED.folio_sustitucion, cancelaciones.folio_sustitucion),
              uuid_cfdi         = COALESCE(EXCLUDED.uuid_cfdi, cancelaciones.uuid_cfdi)
            `,
            [
              c.id_cancelacion_origen,
              c.venta_id ?? null,
              c.fecha_emision ?? null,
              c.fecha_cancelacion ?? null,
              c.motivo_cancelacion ?? null,
              c.folio_sustitucion ?? null,
              c.uuid_cfdi ?? null,
            ]
          );

          // 2) Si hay venta_id, marcamos la venta como cancelada (si existe)
          if (c.venta_id != null) {
            await client.query(
              `
              UPDATE ventas
              SET
                cancelada = true,
                fecha_cancelacion = COALESCE($2::timestamptz, fecha_cancelacion),
                motivo_cancelacion = COALESCE($3::text, motivo_cancelacion),
                folio_sustitucion  = COALESCE($4::text, folio_sustitucion),
                uuid_cfdi          = COALESCE($5::text, uuid_cfdi),
                actualizado_en     = now()
              WHERE venta_id = $1::bigint
                AND sucursal_id = $6::text
              `,
              [
                c.venta_id,
                c.fecha_cancelacion ?? null,
                c.motivo_cancelacion ?? null,
                c.folio_sustitucion ?? null,
                c.uuid_cfdi ?? null,
                FORCED_SUCURSAL_ID,
              ]
            );
          }
        });

        okCount++;
      } catch (e) {
        errorCount++;
        const reason = e instanceof Error ? e.message : "Error desconocido";
        errors.push({ id_cancelacion_origen: c.id_cancelacion_origen, reason });
        console.error("[cancelaciones.import-batch] error", {
          id_cancelacion_origen: c.id_cancelacion_origen,
          reason,
        });
      }
    }

    // import_log (si ya lo usas, lo mantenemos)
    try {
      await pool.query(
        `
        INSERT INTO import_log(batch_id, source_id, items, ok, dup, error, details)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [batchId, sourceId, items.length, okCount, dupCount, errorCount, JSON.stringify(errors)]
      );
    } catch (e) {
      console.error("[cancelaciones.import-batch] error escribiendo import_log", e);
    }

    // estado_sincronizacion:
    // Si tu tabla hoy SOLO tiene ultimo_id_venta, en este paso NO lo tocamos.
    // (Luego agregamos ultimo_id_cancelacion con una migración, en el siguiente paso.)
    return res.json({
      ok: okCount,
      dup: dupCount,
      error: errorCount,
      batch_id: batchId,
      errors,
      max_id_cancelacion: maxCancelId,
    });
  }
);

export default router;

