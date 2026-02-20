import { z } from "zod";

export const ArchivoInitSchema = z.object({
  nombre_original: z.string().min(1).max(200),
  tipo_mime: z.string().min(1).max(200),
  tamanio_bytes: z.number().int().positive().max(1024 * 1024 * 1024), // 1GB
  carpeta_logica: z.string().max(300).optional(),
  etiquetas: z.array(z.string().max(50)).max(30).optional(),
  venta_id: z.number().int().positive().optional(),
  referencia: z.string().max(200).optional(),
});

export const ParteUrlSchema = z.object({
  numero_parte: z.number().int().min(1).max(10000),
});

export const CompletarSchema = z.object({
  partes: z.array(
    z.object({
      numero_parte: z.number().int().min(1),
      etag: z.string().min(1),
    })
  ).min(1),
});
