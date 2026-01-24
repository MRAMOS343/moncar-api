// src/schemas/ventas.ts
import { z } from "zod";

const NullishTrimmed = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const s = String(v ?? "").trim();
    return s.length ? s : null;
  });

export const PagoSchema = z.object({
  idx: z.number().int().min(1),
  metodo: z.string().trim().min(1),
  monto: z.number(),
});

export const LineaVentaSchema = z
  .object({
    articulo: z.string().trim().min(1),
    cantidad: z.number(),
    precio: z.number(),

    impuesto: z.number().optional().nullable(),
    observ: NullishTrimmed.optional(),
    id_salida: z.number().int().optional().nullable(),
    usuario: NullishTrimmed.optional(),
    usuhora: NullishTrimmed.optional(),
    almacen: NullishTrimmed.optional(),
    estado: NullishTrimmed.optional(),

    // si tu extractor ya lo trae:
    usu_fecha: z.string().optional().nullable(),
  })
  .passthrough();

export const VentaSchema = z.object({
  id_venta: z.number().int(),
  fecha_emision: z.string().min(1),

  subtotal: z.number(),
  impuestos: z.number(),
  total: z.number(),

  sucursal: NullishTrimmed.optional(),
  caja: NullishTrimmed.optional(),
  serie: NullishTrimmed.optional(),
  folio: NullishTrimmed.optional(),

  // Campos origen POS
  cliente_origen: NullishTrimmed.optional(),
  datos_origen: NullishTrimmed.optional(),
  estado_origen: NullishTrimmed.optional(),
  usu_fecha: z.string().optional().nullable(),
  usu_hora: NullishTrimmed.optional(),
  no_referencia: NullishTrimmed.optional(),

  pagos: z.array(PagoSchema),
  lineas: z.array(LineaVentaSchema),

  origen: NullishTrimmed.optional(),
});

export const BatchVentasSchema = z.array(VentaSchema);
