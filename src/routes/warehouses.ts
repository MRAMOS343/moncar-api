// src/routes/warehouses.ts
import { Router } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth"; // ajusta al nombre real en tu repo

const router = Router();

/**
 * GET /warehouses
 * Devuelve sucursales desde Postgres.
 * Por defecto incluye inactivas (para que el menú refleje lo que hay en DB).
 * Si quieres solo activas: /warehouses?only_active=1
 */
router.get("/warehouses", requireAuth, async (req, res) => {
  const onlyActive = req.query.only_active === "1";

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
    WHERE ($1::boolean = false) OR (activo = true)
    ORDER BY nombre ASC
    `,
    [onlyActive]
  );

  // Si por error hay sucursales sin codigo, fallamos explícito:
  const missing = rows.filter(r => !r.id);
  if (missing.length > 0) {
    return res.status(500).json({
      error: "Hay sucursales sin codigo. Debes poblar la columna sucursales.codigo.",
      count: missing.length,
    });
  }

  return res.json(rows);
});

export default router;

