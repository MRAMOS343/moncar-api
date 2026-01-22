// src/schemas/ventas.ts
import { z } from "zod";

export const PagoSchema = z.object({
  idx: z.number().int().nonnegative(),
  metodo: z.string().min(1),
  monto: z.number(),
});

export const LineaVentaSchema = z.object({
  articulo: z.string().min(1),
  cantidad: z.number(),
  precio: z.number(),

  costo: z.number().nullable().optional(),
  descuento: z.number().nullable().optional(),
  impuesto: z.number().nullable().optional(),

  // extras POS (opcionales)
  observ: z.string().nullable().optional(),
  id_salida: z.number().nullable().optional(),
  usuario: z.string().nullable().optional(),
  usuhora: z.string().nullable().optional(),
  almacen: z.string().nullable().optional(),
  estado: z.string().nullable().optional(),

  // extras varios (opcionales)
  preciobase: z.number().nullable().optional(),
  costo_u: z.number().nullable().optional(),
  puid: z.string().nullable().optional(),
});

export const VentaSchema = z.object({
  id_venta: z.number().int(),
  fecha_emision: z.string(),

  // forma “nueva”
  sucursal: z.string().nullable().optional(),
  caja: z.string().nullable().optional(),
  serie: z.string().nullable().optional(),
  folio: z.string().nullable().optional(),

  // aliases (por compatibilidad con payloads viejos)
  caja_id: z.string().nullable().optional(),
  serie_documento: z.string().nullable().optional(),
  folio_numero: z.string().nullable().optional(),

  subtotal: z.number(),
  impuestos: z.number(),
  total: z.number(),

  // NUEVO: campos POS que quieres conservar
  estado: z.string().nullable().optional(),         // ESTADO (CO/CA/etc)
  cliente: z.string().nullable().optional(),        // CLIENTE
  datos: z.string().nullable().optional(),          // DATOS
  usu_fecha: z.string().nullable().optional(),      // USUFECHA
  usu_hora: z.string().nullable().optional(),       // USUHORA
  no_referencia: z.string().nullable().optional(),  // NO_REFEREN (si lo mandas así)

  origen: z.string().nullable().optional(),

  lineas: z.array(LineaVentaSchema),
  pagos: z.array(PagoSchema).default([]),
});

export const BatchVentasSchema = z.array(VentaSchema);
export type TipoVenta = z.infer<typeof VentaSchema>;
