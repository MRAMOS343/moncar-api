// src/routes/rutasVehiculos.ts
import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireAnyRole } from "../middleware/requireAnyRole";
import { queryDocs as query } from "../dbDocs";
import { RutaCreateSchema, RutaPatchSchema } from "../schemas/vehiculos";

const router = Router();

// Admin-only
router.use(requireAuth, requireAnyRole(["admin"]));

router.get("/rutas", async (_req: Request, res: Response) => {
  const rows = await query<{
    ruta_id: string;
    nombre: string;
    descripcion: string;
    activa: boolean;
    creado_en: string;
    actualizado_en: string;
    unidades_count: number;
  }>(
    `
    SELECT
      r.ruta_id,
      r.nombre,
      r.descripcion,
      r.activa,
      r.creado_en,
      r.actualizado_en,
      COUNT(u.unidad_id)::int AS unidades_count
    FROM rutas r
    LEFT JOIN unidades u ON u.ruta_id = r.ruta_id
    GROUP BY r.ruta_id
    ORDER BY lower(r.nombre) ASC
    `
  );

  return res.json({ items: rows });
});

router.post("/rutas", async (req: Request, res: Response) => {
  const parsed = RutaCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: parsed.error.flatten() });

  const { nombre, descripcion, activa } = parsed.data;

  const [row] = await query<{ ruta_id: string }>(
    `
    INSERT INTO rutas (nombre, descripcion, activa)
    VALUES ($1, $2, $3)
    RETURNING ruta_id
    `,
    [nombre, descripcion ?? "", activa ?? true]
  );

  return res.status(201).json({ ok: true, ruta_id: row.ruta_id });
});

router.patch("/rutas/:ruta_id", async (req: Request, res: Response) => {
  const rutaId = req.params.ruta_id;

  const parsed = RutaPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_REQUEST", details: parsed.error.flatten() });

  const patch = parsed.data;

  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (patch.nombre !== undefined) { sets.push(`nombre = $${idx++}`); params.push(patch.nombre); }
  if (patch.descripcion !== undefined) { sets.push(`descripcion = $${idx++}`); params.push(patch.descripcion); }
  if (patch.activa !== undefined) { sets.push(`activa = $${idx++}`); params.push(patch.activa); }

  if (sets.length === 0) return res.status(400).json({ ok: false, error: "NO_FIELDS" });

  params.push(rutaId);

  const updated = await query(
    `
    UPDATE rutas
    SET ${sets.join(", ")}
    WHERE ruta_id = $${idx}
    RETURNING ruta_id
    `,
    params
  );

  if (updated.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  return res.json({ ok: true });
});

router.delete("/rutas/:ruta_id", async (req: Request, res: Response) => {
  const rutaId = req.params.ruta_id;

  const [{ cnt }] = await query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM unidades WHERE ruta_id = $1`,
    [rutaId]
  );

  if (cnt > 0) {
    return res.status(409).json({
      ok: false,
      error: "RUTA_CON_UNIDADES",
      message: "No puedes borrar una ruta que todavía tiene unidades. Borra/mueve unidades primero.",
    });
  }

  const deleted = await query<{ ruta_id: string }>(
    `DELETE FROM rutas WHERE ruta_id = $1 RETURNING ruta_id`,
    [rutaId]
  );

  if (deleted.length === 0) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
  return res.json({ ok: true });
});

export default router;
