// src/schemas/ventas.ts
import { z } from "zod";

/**
 * Métodos de pago permitidos (alineados con tipo_metodo_pago en Postgres):
 * 'efectivo', 'debito', 'credito', 'transferencia', 'cheque', 'otro'
 */
export const MetodoPagoSchema = z.enum([
  "efectivo",
  "debito",
  "credito",
  "transferencia",
  "cheque",
  "otro",
]);

/**
 * Pago de una venta
 */
export const PagoSchema = z.object({
  indice: z.number().int().min(1),
  metodo: MetodoPagoSchema,
  monto: z.number().nonnegative(),
});

/**
 * Línea de venta (partida)
 */
export const LineaVentaSchema = z.object({
  numero_linea: z.number().int().min(1),
  sku: z.string().min(1),
  cantidad: z.number(),            // puede ser decimal
  precio_unitario: z.number(),
  descuento: z.number().optional().default(0),
  total_linea: z.number(),
  almacen_pos: z.string().optional().nullable(),
});

/**
 * Venta completa (encabezado + líneas + pagos)
 *
 * id_venta = VENTA del POS (clave natural / sale_id)
 */
export const VentaSchema = z.object({
  id_venta: z.number().int().nonnegative(),
  fecha_hora_local: z.string().min(1), // Idealmente ISO; el backend puede parsear a Date
  sucursal_pos: z.string().optional().nullable(),
  caja: z.string().optional().nullable(),
  folio_serie: z.string().optional().nullable(),
  folio_numero: z.string().optional().nullable(),

  subtotal: z.number(),
  impuesto: z.number(),
  total: z.number(),

  // Id lógico de la fuente (PC/POS) que manda los datos
  source_id: z.string().optional(),

  lineas: z.array(LineaVentaSchema).nonempty(),
  pagos: z.array(PagoSchema).nonempty(),
});

/**
 * Lote de ventas para /ventas/import-batch
 */
export const BatchVentasSchema = z.array(VentaSchema);

