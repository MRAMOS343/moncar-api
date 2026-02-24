// src/schemas/vehiculos.ts
import { z } from "zod";

export const RutaCreateSchema = z.object({
  nombre: z.string().min(1).max(120),
  descripcion: z.string().max(500).optional().default(""),
  activa: z.boolean().optional().default(true),
});

export const RutaPatchSchema = z.object({
  nombre: z.string().min(1).max(120).optional(),
  descripcion: z.string().max(500).optional(),
  activa: z.boolean().optional(),
});

export const UnidadCreateSchema = z.object({
  numero: z.string().min(1).max(20),         // "Unidad 04"
  placa: z.string().min(1).max(20),
  marca: z.string().max(60).optional().default(""),
  modelo: z.string().max(60).optional().default(""),
  anio: z.number().int().min(1900).max(2100).optional(),
  color: z.string().max(30).optional().default(""),
  km: z.number().int().min(0).optional().default(0),
  estado: z.enum(["activa", "taller", "baja"]).optional().default("activa"),
  descripcion: z.string().max(500).optional().default(""),
});

export const UnidadPatchSchema = z.object({
  numero: z.string().min(1).max(20).optional(),
  placa: z.string().min(1).max(20).optional(),
  marca: z.string().max(60).optional(),
  modelo: z.string().max(60).optional(),
  anio: z.number().int().min(1900).max(2100).optional().nullable(),
  color: z.string().max(30).optional(),
  km: z.number().int().min(0).optional(),
  estado: z.enum(["activa", "taller", "baja"]).optional(),
  descripcion: z.string().max(500).optional(),
});

export const DocumentoUnidadCreateSchema = z.object({
  tipo: z.enum([
    "cromatica",
    "factura",
    "poliza_seguro",
    "tarjeta_circulacion",
    "titulo_concesion",
    "verificacion",
    "permiso",
    "otro",
  ]),
  nombre: z.string().min(1).max(200),
  notas: z.string().max(2000).optional().default(""),
  fecha_documento: z.string().date().optional(),
  vigencia_hasta: z.string().date().optional(),
  archivo_id: z.string().uuid(),             // FK lógico a archivos.archivo_id
});

export const DocumentoUnidadPatchSchema = z.object({
  tipo: z
    .enum([
      "cromatica",
      "factura",
      "poliza_seguro",
      "tarjeta_circulacion",
      "titulo_concesion",
      "verificacion",
      "permiso",
      "otro",
    ])
    .optional(),
  nombre: z.string().min(1).max(200).optional(),
  notas: z.string().max(2000).optional(),
  fecha_documento: z.string().date().optional().nullable(),
  vigencia_hasta: z.string().date().optional().nullable(),
});

export const AlertaUpsertSchema = z.object({
  dias_antes: z.number().int().min(1).max(365).optional().default(30),
  activa: z.boolean().optional().default(true),
});

export const PorVencerQuerySchema = z.object({
  dias: z.coerce.number().int().min(0).max(365).default(30),
});
