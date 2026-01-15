// src/routes/warehouses.ts
import { Router } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

/**
 * GET /warehouses
 * Devuelve sucursales desde Postgres.
 *
 * Filtros soportados:
 *  - /warehouses                       -> todas
 *  - /warehouses?only_active=1         -> solo activas (alias legacy)
 *  - /warehouses?activo=true|1         -> solo activas
 *  - /warehouses?activo=false|0        -> solo inactivas
 */
router.get("/warehouses", requireAuth, async (req, res) => {
  // Parse robusto del query param "activo" (si existe)
  const activoRaw = req.query.activo;
  let activoFilter: boolean | undefined = undefined;

  if (typeof activoRaw === "string" && activoRaw.trim() !== "") {
    const v = activoRaw.trim().toLowerCase();
    if (v === "true" || v === "1") activoFilter = true;
    else if (v === "false" || v === "0") activoFilter = false;
    else {
      return res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        reason: "INVALID_QUERY_ACTIVO",
        hint: "Usa activo=true|false|1|0",
      });
    }
  }

  // Compatibilidad: only_active=1 equivale a activo=true (solo si "activo" no fue especificado)
  const onlyActive = req.query.only_active === "1";
  if (activoFilter === undefined && onlyActive) {
    activoFilter = true;
  }

  const rows = await query<{
    id: string;
    nombre: string;
    direccion: string | null;
    telefono: string | null;
    activo: boolean;
  }>(
    `
    SELECT
      codigo AS id,
      nombre,
      direccion,
      telefono,
      activo
    FROM sucursales
    WHERE ($1::boolean IS NULL) OR (activo = $1::boolean)
    ORDER BY nombre ASC
    `,
    [activoFilter ?? null]
  );

  // Si por error hay sucursales sin codigo, fallamos explícito:
  const missing = rows.filter((r) => !r.id);
  if (missing.length > 0) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      reason: "MISSING_SUCURSALES_CODIGO",
      message:
        "Hay sucursales sin codigo. Debes poblar la columna sucursales.codigo.",
      count: missing.length,
    });
  }

  return res.json(rows);
});

export default router;
