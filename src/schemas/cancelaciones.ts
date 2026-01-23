// src/schemas/cancelaciones.ts
import { z } from "zod";

const NullishTrimmed = z
  .string()
  .transform((s) => s.trim())
  .refine(() => true)
  .optional()
  .nullable();

const NullishIsoDate = z
  .string()
  .datetime()
  .optional()
  .nullable();

export const CancelacionSchema = z.object({
  id_cancelacion_origen: z.number().int().nonnegative(),

  venta_id: z.number().int().nonnegative().optional().nullable(),

  fecha_emision: NullishIsoDate,
  fecha_cancelacion: NullishIsoDate,

  // nuevos (objetivo)
  cliente_origen: NullishTrimmed,
  cliente_nombre: NullishTrimmed,
  importe: z.number().optional().nullable(),

  // ya existían / útiles
  motivo_cancelacion: NullishTrimmed,
  folio_sustitucion: NullishTrimmed,
  uuid_cfdi: NullishTrimmed,
});

export const BatchCancelacionesSchema = z.array(CancelacionSchema);
