// src/services/ventasService.ts
import { randomUUID } from "crypto";
import { pool, withTransaction, query } from "../db";
import { logger } from "../logger";
import { config } from "../config";
import { cacheInvalidate } from "../utils/dbCache";

export interface VentaInput {
  id_venta: number;
  fecha: string;
  subtotal?: number;
  lineas?: LineaInput[];
  pagos?: PagoInput[];
  // Campos opcionales con múltiples aliases
  [key: string]: unknown;
}

export interface LineaInput {
  renglon?: number;
  articulo?: string;
  cantidad?: number;
  precio?: number;
  precio_unitario?: number;
  descuento?: number;
  impuesto?: number;
  impuesto_linea?: number;
  importe?: number;
  almacen?: string | null;
  almacen_id?: string | null;
  id_salida?: number | null;
  id_salida_origen?: number | null;
  estado?: string | null;
  estado_linea?: string | null;
  observ?: string | null;
  observ_origen?: string | null;
  usuario?: string | null;
  usuario_origen?: string | null;
  usuhora?: string | null;
  usu_hora?: string | null;
  usu_fecha?: string | null;
  [key: string]: unknown;
}

export interface PagoInput {
  idx?: number;
  metodo?: string;
  monto?: number;
}

export interface ImportBatchResult {
  ok: number;
  dup: number;
  error: number;
  batch_id: string | null;
  errors: { id_venta: number; reason: string }[];
  max_id_venta: number;
}

/**
 * Servicio de Ventas - Lógica de negocio separada del HTTP layer.
 */
export class VentasService {
  private sucursalId: string;
  private sourceId: string | null;

  constructor(sucursalId?: string) {
    this.sucursalId = sucursalId ?? config.forcedSucursalId;
    this.sourceId = config.sourceId;
  }

  /**
   * Importa un batch de ventas desde sistema externo (POS).
   */
  async importBatch(ventas: VentaInput[]): Promise<ImportBatchResult> {
    if (!this.sourceId) {
      throw new Error("SOURCE_ID no configurado");
    }

    if (ventas.length === 0) {
      return { ok: 0, dup: 0, error: 0, batch_id: null, errors: [], max_id_venta: 0 };
    }

    const batchId = randomUUID();
    let okCount = 0;
    let dupCount = 0;
    let errorCount = 0;
    let maxIdVenta = 0;
    const errorDetails: { id_venta: number; reason: string }[] = [];

    for (const venta of ventas) {
      maxIdVenta = Math.max(maxIdVenta, venta.id_venta);

      try {
        await this.procesarVenta(venta);
        okCount++;
      } catch (e) {
        errorCount++;
        const reason = e instanceof Error ? e.message : "Error desconocido";
        errorDetails.push({ id_venta: venta.id_venta, reason });
        logger.error({ id_venta: venta.id_venta, reason }, "ventas.import.error");
      }
    }

    // Registrar en import_log
    await this.registrarImportLog(batchId, ventas.length, okCount, dupCount, errorCount, errorDetails);

    // Actualizar estado de sincronización
    if (maxIdVenta > 0) {
      await this.actualizarEstadoSync(maxIdVenta);
    }

    if (okCount > 0) {
      await Promise.all([
        cacheInvalidate("kpis:"),
        cacheInvalidate("tendencia:"),
        cacheInvalidate("metodos_pago:"),
        cacheInvalidate("top_productos:"),
      ]);
    }

    return { ok: okCount, dup: dupCount, error: errorCount, batch_id: batchId, errors: errorDetails, max_id_venta: maxIdVenta };
  }

  /**
   * Procesa una venta individual dentro de una transacción.
   */
  private async procesarVenta(venta: VentaInput): Promise<void> {
    const subtotal = Number(venta.subtotal ?? 0);
    const impuesto = Number(venta.impuestos ?? venta.impuesto ?? 0);
    const total = subtotal + impuesto;

    // Mapeos robustos para compatibilidad
    const cajaVal = venta.caja ?? venta.caja_id ?? null;
    const serieVal = venta.serie ?? venta.serie_documento ?? venta.serieDocumento ?? null;
    const folioVal = venta.folio ?? venta.folio_numero ?? venta.folioNumero ?? venta.no_referencia ?? venta.NO_REFEREN ?? null;
    const estadoVal = venta.estado_origen ?? venta.estado ?? null;
    const clienteVal = venta.cliente_origen ?? venta.cliente ?? null;
    const datosVal = venta.datos_origen ?? venta.datos ?? null;
    const clienteNombreVal = venta.cliente_nombre ?? venta.nombre_cliente ?? null;
    const clienteTelefonoVal = venta.cliente_telefono ?? venta.telefono_cliente ?? null;
    const clienteEmailVal = venta.cliente_email ?? venta.email_cliente ?? null;
    const clienteEmpresaVal = venta.cliente_empresa ?? venta.empresa_cliente ?? null;
    const usuFechaVal = venta.usu_fecha ?? null;
    const usuHoraVal = venta.usu_hora ?? null;
    const noRefVal = venta.no_referencia ?? venta.NO_REFEREN ?? venta.folio ?? venta.folio_numero ?? null;

    await withTransaction(async (client) => {
      // Encabezado (UPSERT)
      await client.query(
        `
        INSERT INTO ventas (
          venta_id, fecha_emision, sucursal_id, caja_id, serie_documento,
          folio_numero, no_referencia, cliente_origen, datos_origen, cliente_nombre,
          cliente_telefono, cliente_email, cliente_empresa, estado_origen,
          usu_fecha, usu_hora, subtotal, impuesto, total
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (venta_id) DO UPDATE SET
          fecha_emision = EXCLUDED.fecha_emision,
          sucursal_id = EXCLUDED.sucursal_id,
          caja_id = EXCLUDED.caja_id,
          serie_documento = EXCLUDED.serie_documento,
          folio_numero = EXCLUDED.folio_numero,
          no_referencia = EXCLUDED.no_referencia,
          cliente_origen = EXCLUDED.cliente_origen,
          datos_origen = EXCLUDED.datos_origen,
          cliente_nombre = EXCLUDED.cliente_nombre,
          cliente_telefono = EXCLUDED.cliente_telefono,
          cliente_email = EXCLUDED.cliente_email,
          cliente_empresa = EXCLUDED.cliente_empresa,
          estado_origen = EXCLUDED.estado_origen,
          usu_fecha = EXCLUDED.usu_fecha,
          usu_hora = EXCLUDED.usu_hora,
          subtotal = EXCLUDED.subtotal,
          impuesto = EXCLUDED.impuesto,
          total = EXCLUDED.total,
          actualizado_en = now()
        `,
        [
          venta.id_venta,
          venta.fecha,
          this.sucursalId,
          cajaVal,
          serieVal,
          folioVal,
          noRefVal,
          clienteVal,
          datosVal,
          clienteNombreVal,
          clienteTelefonoVal,
          clienteEmailVal,
          clienteEmpresaVal,
          estadoVal,
          usuFechaVal,
          usuHoraVal,
          subtotal,
          impuesto,
          total,
        ]
      );

      // Líneas (reemplazo total)
      await client.query("DELETE FROM lineas_venta WHERE venta_id = $1", [venta.id_venta]);

      for (const linea of venta.lineas ?? []) {
        await this.insertarLinea(client, venta.id_venta, linea);
      }

      // Pagos (reemplazo total)
      await client.query("DELETE FROM pagos_venta WHERE venta_id = $1", [venta.id_venta]);

      for (const pago of venta.pagos ?? []) {
        await client.query(
          `INSERT INTO pagos_venta (venta_id, idx, metodo, monto) VALUES ($1, $2, $3, $4)`,
          [venta.id_venta, Number(pago.idx ?? 0), String(pago.metodo ?? ""), Number(pago.monto ?? 0)]
        );
      }
    });
  }

  /**
   * Inserta una línea de venta.
   */
  private async insertarLinea(client: any, ventaId: number, linea: LineaInput): Promise<void> {
    const cantidad = Number(linea.cantidad ?? 0);
    const precioUnitario = Number(linea.precio ?? linea.precio_unitario ?? 0);
    const descuento = Number(linea.descuento ?? 0);
    const impuestoLinea = Number(linea.impuesto ?? linea.impuesto_linea ?? 0);
    const importeLinea = linea.importe != null ? Number(linea.importe) : cantidad * precioUnitario - descuento + impuestoLinea;

    await client.query(
      `
      INSERT INTO lineas_venta (
        venta_id, renglon, articulo, cantidad, precio_unitario,
        descuento, impuesto_linea, importe_linea, almacen_id,
        id_salida_origen, estado_linea, observ_origen, usuario_origen, usu_hora, usu_fecha
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `,
      [
        ventaId,
        linea.renglon ?? 0,
        linea.articulo ?? "",
        cantidad,
        precioUnitario,
        descuento,
        impuestoLinea,
        importeLinea,
        linea.almacen ?? linea.almacen_id ?? null,
        linea.id_salida ?? linea.id_salida_origen ?? null,
        linea.estado ?? linea.estado_linea ?? null,
        linea.observ ?? linea.observ_origen ?? null,
        linea.usuario ?? linea.usuario_origen ?? null,
        linea.usu_hora ?? null,
        linea.usu_fecha ?? null,
      ]
    );
  }

  /**
   * Registra el batch en import_log.
   */
  private async registrarImportLog(
    batchId: string,
    items: number,
    ok: number,
    dup: number,
    error: number,
    details: { id_venta: number; reason: string }[]
  ): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO import_log (batch_id, source_id, items, ok, dup, error, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [batchId, this.sourceId, items, ok, dup, error, JSON.stringify(details)]
      );
    } catch (e) {
      logger.error({ err: e }, "ventas.import_log.error");
    }
  }

  /**
   * Actualiza estado_sincronizacion con el último ID procesado.
   */
  private async actualizarEstadoSync(maxIdVenta: number): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO estado_sincronizacion (source_id, last_venta_id, last_sync_at)
         VALUES ($1, $2, now())
         ON CONFLICT (source_id) DO UPDATE SET
           last_venta_id = GREATEST(estado_sincronizacion.last_venta_id, EXCLUDED.last_venta_id),
           last_sync_at = now()`,
        [this.sourceId, maxIdVenta]
      );
    } catch (e) {
      logger.error({ err: e }, "ventas.sync_state.error");
    }
  }

  /**
   * Obtiene el detalle de una venta con sus líneas y pagos.
   */
  async getVentaDetalle(ventaId: number): Promise<{
    venta: Record<string, unknown> | null;
    lineas: Record<string, unknown>[];
    pagos: Record<string, unknown>[];
  }> {
    const ventaRows = await query(
      `SELECT * FROM ventas WHERE venta_id = $1`,
      [ventaId]
    );

    if (ventaRows.length === 0) {
      return { venta: null, lineas: [], pagos: [] };
    }

    const lineas = await query(
      `SELECT * FROM lineas_venta WHERE venta_id = $1 ORDER BY renglon`,
      [ventaId]
    );

    const pagos = await query(
      `SELECT * FROM pagos_venta WHERE venta_id = $1 ORDER BY idx`,
      [ventaId]
    );

    return { venta: ventaRows[0], lineas, pagos };
  }
}

// Singleton para uso general
export const ventasService = new VentasService();
