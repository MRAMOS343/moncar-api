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

/**
 * Regla para "código de sucursal":
 * - texto no vacío (trim)
 * - normalmente viene tipo "SUC001", "MTY", etc.
 * Ajusta el regex si quieres restringir el formato.
 */
const SucursalCodigo = z.string().trim().min(1).max(32);

/**
 * CreateEquipoSchema
 *
 * Migración:
 * - NUEVO: sucursal_codigo (text) -> apunta a sucursales.codigo
 * - LEGACY (temporal): sucursal_id (uuid u otro) para compat durante transición.
 *
 * Nota: Para gerente normalmente se ignora lo que venga y se usa la sucursal del usuario.
 */
export const CreateEquipoSchema = z.object({
  nombre: z.string().trim().min(1).max(100),
  descripcion: NullishTrimmed.optional(),

  lider_usuario_id: z
    .union([z.string().uuid(), z.null(), z.undefined()])
    .transform((v) => (v === undefined ? undefined : v ?? null))
    .optional(),

  // NUEVO (preferido)
  // Admin puede mandarlo; gerente se ignora y se usa el del usuario.
  sucursal_codigo: z.union([SucursalCodigo, z.null(), z.undefined()])
    .transform((v) => (v === undefined ? undefined : (typeof v === "string" ? v.trim() : v ?? null)))
    .optional(),

  // LEGACY (temporal): para no romper clientes viejos mientras migras el backend/front
  // Se recomienda eliminarlo cuando todo use sucursal_codigo.
  sucursal_id: NullishTrimmed.optional(),
});

export const UpdateEquipoSchema = z.object({
  nombre: z.string().trim().min(1).max(100).optional(),
  descripcion: NullishTrimmed.optional(),

  // null explícito = quitar líder
  lider_usuario_id: z.union([z.string().uuid(), z.null()]).optional(),

  // NUEVO (preferido)
  // NO permitimos null si tu columna equipos.sucursal_codigo es NOT NULL (lo validas en handler).
  // Si mandan vacío -> null por NullishTrimmed; lo rechazarás en el handler.
  sucursal_codigo: z.union([SucursalCodigo, z.null(), z.undefined()])
    .transform((v) => (v === undefined ? undefined : (typeof v === "string" ? v.trim() : v ?? null)))
    .optional(),

  // LEGACY (temporal): idem arriba (rechazarás cambios si no es admin, etc.)
  sucursal_id: NullishTrimmed.optional(),

  activo: z.boolean().optional(),
});

export const AddMiembroSchema = z.object({
  usuario_id: z.string().uuid(),
  rol_equipo: NullishTrimmed.optional(), // ej: 'miembro' | 'coordinador' | 'vendedor'
});
