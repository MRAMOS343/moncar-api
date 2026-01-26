// src/routes/usuarios.ts
import { Router, Request, Response } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function clampLimit(raw: unknown, def = 50, max = 200) {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function parseQ(raw: unknown): string {
  return String(raw ?? "").trim();
}

type Role = "admin" | "gerente" | "cajero" | "user";

/**
 * Obtiene contexto del usuario autenticado.
 * Soporta ambos shapes (req.user / req.auth) por compat con tu historial de auth.
 */
async function getUserContext(req: Request): Promise<{ userId: string; role: Role; sucursalIdText: string | null }> {
  const u = (req as any).user ?? {};
  const a = (req as any).auth ?? {};

  const userId = String(u.id ?? a.sub ?? "").trim();
  if (!userId) return { userId: "", role: "user", sucursalIdText: null };

  // Fuente de verdad: tabla usuarios (rol y sucursal)
  const rows = await query<{ rol: string; sucursal_id: any }>(
    `SELECT rol, sucursal_id
     FROM public.usuarios
     WHERE id_usuario = $1
     LIMIT 1`,
    [userId]
  );

  const row = rows[0];
  if (!row) return { userId: "", role: "user", sucursalIdText: null };

  const rolDb = String(row.rol ?? "").toLowerCase().trim();
  const role: Role = rolDb === "admin" || rolDb === "gerente" || rolDb === "cajero" ? (rolDb as Role) : "user";

  const sucursalIdText = row.sucursal_id != null ? String(row.sucursal_id) : null;

  return { userId, role, sucursalIdText };
}

/**
 * GET /usuarios?q=&limit=
 * Devuelve usuarios (para combobox/autocomplete):
 *  - usuario_id
 *  - nombre
 *  - email (mapeado desde usuarios.correo)
 *
 * Permisos:
 *  - admin: todos
 *  - gerente: solo su sucursal
 *  - cajero: forbidden
 */
router.get("/usuarios", requireAuth, async (req: Request, res: Response) => {
  const { role, sucursalIdText } = await getUserContext(req);

  if (role !== "admin" && role !== "gerente") {
    return res.status(403).json({ ok: false, reason: "FORBIDDEN" });
  }

  const limit = clampLimit(req.query.limit, 50, 200);
  const q = parseQ(req.query.q);

  const where: string[] = [];
  const args: any[] = [];
  let idx = 1;

  // gerente: solo su sucursal
  if (role === "gerente") {
    if (!sucursalIdText) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
    where.push(`u.sucursal_id::text = $${idx++}`);
    args.push(sucursalIdText);
  }

  // búsqueda por nombre o correo
  if (q) {
    where.push(`(u.nombre ILIKE $${idx} OR u.correo ILIKE $${idx})`);
    args.push(`%${q}%`);
    idx++;
  }

  // Nota: NO devolvemos password_hash ni campos sensibles.
  const sql = `
    SELECT
      u.id_usuario AS usuario_id,
      u.nombre,
      u.correo AS email
    FROM public.usuarios u
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY u.nombre ASC, u.id_usuario ASC
    LIMIT $${idx++}
  `;

  args.push(limit);

  const rows = await query<{ usuario_id: string; nombre: string; email: string }>(sql, args);

  return res.json({
    ok: true,
    items: rows.map((r) => ({
      usuario_id: r.usuario_id,
      nombre: r.nombre,
      email: r.email,
    })),
  });
});

export default router;

