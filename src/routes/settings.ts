// src/routes/settings.ts
import { Router } from "express";
import { z } from "zod";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";

const router = Router();

const CompanyPatchSchema = z.object({
  nombre_empresa: z.string().trim().min(1).max(200).optional(),
  rfc: z.string().trim().min(10).max(13).optional(),
  direccion: z.string().trim().min(1).optional(),
  telefono: z.string().trim().min(1).max(20).optional(),
  logo_url: z.string().trim().url().max(500).nullable().optional(),
}).strict();

const InventoryPatchSchema = z.object({
  stock_minimo_global: z.number().int().min(0).optional(),
  alertas_activas: z.boolean().optional(),
  formato_sku: z.string().trim().min(1).max(50).optional(),
}).strict();

router.get("/settings/company", requireAuth, requireRole(["admin", "gerente"]), async (_req, res) => {
  const rows = await query(`SELECT * FROM company_settings WHERE id = 1`);
  return res.json({ ok: true, item: rows[0] ?? null });
});

router.patch("/settings/company", requireAuth, requireRole(["admin", "gerente"]), async (req, res) => {
  const parsed = CompanyPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", issues: parsed.error.issues });
  }

  const patch = parsed.data;
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return res.json({ ok: true, item: null });

  const sets: string[] = [];
  const values: any[] = [];
  let i = 1;

  for (const k of keys) {
    sets.push(`${k} = $${i++}`);
    values.push((patch as any)[k]);
  }

  const rows = await query(
    `
    UPDATE company_settings
    SET ${sets.join(", ")}
    WHERE id = 1
    RETURNING *
    `,
    values
  );

  return res.json({ ok: true, item: rows[0] ?? null });
});

router.get("/settings/inventory", requireAuth, requireRole(["admin", "gerente"]), async (_req, res) => {
  const rows = await query(`SELECT * FROM inventory_settings WHERE id = 1`);
  return res.json({ ok: true, item: rows[0] ?? null });
});

router.patch("/settings/inventory", requireAuth, requireRole(["admin", "gerente"]), async (req, res) => {
  const parsed = InventoryPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", issues: parsed.error.issues });
  }

  const patch = parsed.data;
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return res.json({ ok: true, item: null });

  const sets: string[] = [];
  const values: any[] = [];
  let i = 1;

  for (const k of keys) {
    sets.push(`${k} = $${i++}`);
    values.push((patch as any)[k]);
  }

  const rows = await query(
    `
    UPDATE inventory_settings
    SET ${sets.join(", ")}
    WHERE id = 1
    RETURNING *
    `,
    values
  );

  return res.json({ ok: true, item: rows[0] ?? null });
});

export default router;
