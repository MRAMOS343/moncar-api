// src/routes/usersMe.ts
import { Router } from "express";
import { z } from "zod";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

const PreferencesPatchSchema = z.object({
  notif_stock_bajo: z.boolean().optional(),
  notif_nuevas_ventas: z.boolean().optional(),
  notif_nuevos_proveedores: z.boolean().optional(),
  notif_reportes_diarios: z.boolean().optional(),
}).strict();

const ProfilePatchSchema = z.object({
  nombre: z.string().trim().min(1).max(100).optional(),
  telefono: z.string().trim().max(20).nullable().optional(),
  avatar_url: z.string().trim().url().max(500).nullable().optional(),
}).strict();

function asUserId(req: any): string {
  return String(req.user?.id ?? "").trim();
}

router.get("/users/me/preferences", requireAuth, async (req, res) => {
  const usuarioId = asUserId(req);
  if (!usuarioId) return res.status(401).json({ ok: false, reason: "NO_AUTH" });

  await query(
    `INSERT INTO user_preferences (usuario_id)
     VALUES ($1)
     ON CONFLICT (usuario_id) DO NOTHING`,
    [usuarioId]
  );

  const rows = await query(
    `SELECT usuario_id, notif_stock_bajo, notif_nuevas_ventas, notif_nuevos_proveedores, notif_reportes_diarios,
            created_at, updated_at
     FROM user_preferences
     WHERE usuario_id = $1`,
    [usuarioId]
  );

  return res.json({ ok: true, item: rows[0] ?? null });
});

router.patch("/users/me/preferences", requireAuth, async (req, res) => {
  const usuarioId = asUserId(req);
  const parsed = PreferencesPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", issues: parsed.error.issues });
  }

  const patch = parsed.data;
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return res.json({ ok: true, item: null });

  await query(
    `INSERT INTO user_preferences (usuario_id)
     VALUES ($1)
     ON CONFLICT (usuario_id) DO NOTHING`,
    [usuarioId]
  );

  const sets: string[] = [];
  const values: any[] = [usuarioId];
  let i = 2;

  for (const k of keys) {
    sets.push(`${k} = $${i++}`);
    values.push((patch as any)[k]);
  }

  const rows = await query(
    `
    UPDATE user_preferences
    SET ${sets.join(", ")}
    WHERE usuario_id = $1
    RETURNING usuario_id, notif_stock_bajo, notif_nuevas_ventas, notif_nuevos_proveedores, notif_reportes_diarios,
              created_at, updated_at
    `,
    values
  );

  return res.json({ ok: true, item: rows[0] ?? null });
});

router.patch("/users/me/profile", requireAuth, async (req, res) => {
  const usuarioId = asUserId(req);
  const parsed = ProfilePatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", issues: parsed.error.issues });
  }

  const patch = parsed.data;
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return res.json({ ok: true, item: null });

  const sets: string[] = [];
  const values: any[] = [usuarioId];
  let i = 2;

  for (const k of keys) {
    sets.push(`${k} = $${i++}`);
    values.push((patch as any)[k]);
  }

  const rows = await query(
    `
    UPDATE usuarios
    SET ${sets.join(", ")}
    WHERE id_usuario = $1
    RETURNING id_usuario, nombre, email, telefono, avatar_url, sucursal_id, last_login_at
    `,
    values
  );

  if (rows.length === 0) {
    return res.status(404).json({ ok: false, reason: "USER_NOT_FOUND" });
  }

  return res.json({ ok: true, item: rows[0] });
});

export default router;
