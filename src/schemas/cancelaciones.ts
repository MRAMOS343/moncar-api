// src/schemas/cancelaciones.ts
import { z } from "zod";

const NullishTrimmed = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const s = String(v ?? "").trim();
    return s ? s : null;
  });

const IsoDateString = z
  .string()
  .transform((s) => new Date(s))
  .refine((d) => !Number.isNaN(d.getTime()), "Invalid date")
  .transform((d) => d.toISOString());

export const CancelacionSchema = z.object({
  // Id (PK origen, cursor)
  id_cancelacion_origen: z.number().int().positive(),

  // Referencia a venta (puede ser null si todavía no existe la venta)
  venta_id: z.number().int().positive().nullable().optional(),

  // Fechas (opcionales, pero si vienen deben ser ISO)
  fecha_emision: IsoDateString.nullable().optional(),
  fecha_cancelacion: IsoDateString.nullable().optional(),

  // Campos opcionales (según tu tabla)
  motivo_cancelacion: NullishTrimmed.optional(),
  folio_sustitucion: NullishTrimmed.optional(),
  uuid_cfdi: NullishTrimmed.optional(),
});

export const BatchCancelacionesSchema = z.array(CancelacionSchema);
export type CancelacionInput = z.infer<typeof CancelacionSchema>;

