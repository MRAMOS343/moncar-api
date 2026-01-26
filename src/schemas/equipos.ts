// src/schemas/equipos.ts
import { z } from "zod";

/**
 * Convierte string|null|undefined a:
 * - string trimmed
 * - null si queda vacío
 */
const NullishTrimmed = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const s = String(v ?? "").trim();
    return s.length ? s : null;
  });

export const CreateEquipoSchema = z.object({
  nombre: z.string().trim().min(1).max(100),
  descripcion: NullishTrimmed.optional(),
  lider_usuario_id: z
    .union([z.string().uuid(), z.null(), z.undefined()])
    .transform((v) => (v === undefined ? undefined : v ?? null))
    .optional(),
  // OJO: tu columna equipos.sucursal_id es NOT NULL
  // Para admin, puede venir; para gerente se ignora y se usa la sucursal del usuario.
  // El tipo real (uuid/bigint/text) se pasa como string y en SQL usamos "=$n" + casteos por "::text" cuando aplique.
  sucursal_id: NullishTrimmed.optional(),
});

export const UpdateEquipoSchema = z.object({
  nombre: z.string().trim().min(1).max(100).optional(),
  descripcion: NullishTrimmed.optional(),
  // null explícito = quitar líder
  lider_usuario_id: z.union([z.string().uuid(), z.null()]).optional(),
  // NO permitimos null aquí porque equipos.sucursal_id es NOT NULL.
  // Si mandan vacío -> null por NullishTrimmed; lo rechazaremos en el handler.
  sucursal_id: NullishTrimmed.optional(),
  activo: z.boolean().optional(),
});

export const AddMiembroSchema = z.object({
  usuario_id: z.string().uuid(),
  rol_equipo: NullishTrimmed.optional(), // ej: 'miembro' | 'coordinador' | 'vendedor'
});

