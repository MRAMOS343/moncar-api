// src/routes/equipos.ts
import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { AddMiembroSchema, CreateEquipoSchema, UpdateEquipoSchema } from "../schemas/equipos";

const router = Router();

type Role = "admin" | "gerente" | "cajero" | "user";

function clampLimit(raw: unknown, def = 50, max = 200) {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function parseCursorBigint(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "0";
  if (!/^\d+$/.test(s)) return "0";
  return s;
}

function parseQ(raw: unknown): string {
  return String(raw ?? "").trim();
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function getReqUserId(req: Request): string {
  const u = (req as any).user ?? {};
  // Soporta múltiples shapes (por tu historia de "dos auth")
  const id = u.id ?? u.sub ?? u.userId ?? u.id_usuario ?? "";
  return String(id ?? "").trim();
}

async function getUserContext(req: Request): Promise<{ userId: string; role: Role; sucursalIdText: string | null }> {
  const userId = getReqUserId(req);
  if (!userId) return { userId: "", role: "user", sucursalIdText: null };

  const rows = await query<{ sucursal_id: any; rol: string }>(
    `SELECT sucursal_id, rol
     FROM public.usuarios
     WHERE id_usuario = $1
     LIMIT 1`,
    [userId]
  );

  const row = rows[0];
  if (!row) {
    // Token válido pero usuario no existe en BD => tratamos como no autorizado
    throw new HttpError(401, "UNAUTHORIZED");
  }

  const sucursalIdText = row.sucursal_id != null ? String(row.sucursal_id) : null;

  const rolDb = String(row.rol ?? "").toLowerCase().trim();
  const role: Role = (rolDb === "admin" || rolDb === "gerente" || rolDb === "cajero") ? (rolDb as Role) : "user";

  return { userId, role, sucursalIdText };
}

function assertRole(role: Role, allowed: Role[]) {
  if (!allowed.includes(role)) throw new HttpError(403, "FORBIDDEN");
}

async function assertEquipoVisibleByRole(params: {
  equipoId: string;
  role: Role;
  userId: string;
  sucursalIdText: string | null;
}) {
  const { equipoId, role, userId, sucursalIdText } = params;

  if (role === "admin") return;

  if (role === "gerente") {
    if (!sucursalIdText) throw new HttpError(403, "USER_HAS_NO_SUCURSAL");

    const ok = await query<{ ok: number }>(
      `SELECT 1 as ok
       FROM public.equipos e
       WHERE e.equipo_id = $1
         AND e.sucursal_id::text = $2
       LIMIT 1`,
      [equipoId, sucursalIdText]
    );

    if (ok.length === 0) throw new HttpError(404, "EQUIPO_NOT_FOUND_OR_FORBIDDEN");
    return;
  }

  if (role === "cajero") {
    const ok = await query<{ ok: number }>(
      `SELECT 1 as ok
       FROM public.equipos e
       JOIN public.equipo_miembros em
         ON em.equipo_id = e.equipo_id
       WHERE e.equipo_id = $1
         AND e.activo = TRUE
         AND em.usuario_id = $2::uuid
         AND em.activo = TRUE
       LIMIT 1`,
      [equipoId, userId]
    );

    if (ok.length === 0) throw new HttpError(404, "EQUIPO_NOT_FOUND_OR_FORBIDDEN");
    return;
  }

  throw new HttpError(403, "FORBIDDEN");
}

/**
 * GET /equipos
 */
router.get("/equipos", requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { userId, role, sucursalIdText } = await getUserContext(req);

  const limit = clampLimit(req.query.limit, 50, 200);
  const cursor = parseCursorBigint(req.query.cursor);
  const q = parseQ(req.query.q);
  const includeInactive = String(req.query.include_inactive ?? "") === "1";
  const allowInactive = (role === "admin" || role === "gerente") && includeInactive;

  const whereParts: string[] = [];
  const args: any[] = [];
  let idx = 1;

  whereParts.push(`e.equipo_id > $${idx++}`);
  args.push(cursor);

  if (!allowInactive) whereParts.push(`e.activo = TRUE`);

  if (q) {
    whereParts.push(`e.nombre ILIKE $${idx++}`);
    args.push(`%${q}%`);
  }

  if (role === "admin") {
    // sin filtro
  } else if (role === "gerente") {
    if (!sucursalIdText) throw new HttpError(403, "USER_HAS_NO_SUCURSAL");
    whereParts.push(`e.sucursal_id::text = $${idx++}`);
    args.push(sucursalIdText);
  } else if (role === "cajero") {
    whereParts.push(`
      EXISTS (
        SELECT 1
        FROM public.equipo_miembros em
        WHERE em.equipo_id = e.equipo_id
          AND em.usuario_id = $${idx++}::uuid
          AND em.activo = TRUE
      )
    `);
    args.push(userId);
  } else {
    throw new HttpError(403, "FORBIDDEN");
  }

  args.push(limit);

  const sql = `
    SELECT
      e.equipo_id,
      e.nombre,
      e.descripcion,
      e.lider_usuario_id,
      u.nombre AS lider_nombre,
      e.sucursal_id,
      s.nombre AS sucursal_nombre,
      e.activo,
      e.created_at,
      e.updated_at,
      (
        SELECT COUNT(*)
        FROM public.equipo_miembros emc
        WHERE emc.equipo_id = e.equipo_id
          AND emc.activo = TRUE
      ) AS total_miembros
    FROM public.equipos e
    LEFT JOIN public.usuarios u ON u.id_usuario = e.lider_usuario_id
    LEFT JOIN public.sucursales s ON s.id_sucursal = e.sucursal_id
    WHERE ${whereParts.join(" AND ")}
    ORDER BY e.equipo_id ASC
    LIMIT $${idx++};
  `;

  const r = await query<any>(sql, args);

  const items = r.map((row: any) => ({
    equipo_id: String(row.equipo_id),
    nombre: row.nombre,
    descripcion: row.descripcion ?? null,
    lider_usuario_id: row.lider_usuario_id ?? null,
    lider_nombre: row.lider_nombre ?? null,
    sucursal_id: row.sucursal_id != null ? String(row.sucursal_id) : null,
    sucursal_nombre: row.sucursal_nombre ?? null,
    activo: Boolean(row.activo),
    created_at: row.created_at,
    updated_at: row.updated_at,
    total_miembros: Number(row.total_miembros ?? 0),
  }));

  const next_cursor = items.length ? items[items.length - 1].equipo_id : null;
  return res.json({ ok: true, items, next_cursor });
}));

/**
 * GET /equipos/:id
 */
router.get("/equipos/:id", requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { userId, role, sucursalIdText } = await getUserContext(req);

  const equipoId = String(req.params.id ?? "").trim();
  if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });

  await assertEquipoVisibleByRole({ equipoId, role, userId, sucursalIdText });

  const equipoR = await query<any>(
    `
    SELECT
      e.equipo_id,
      e.nombre,
      e.descripcion,
      e.lider_usuario_id,
      u.nombre AS lider_nombre,
      e.sucursal_id,
      s.nombre AS sucursal_nombre,
      e.activo,
      e.created_at,
      e.updated_at
    FROM public.equipos e
    LEFT JOIN public.usuarios u ON u.id_usuario = e.lider_usuario_id
    LEFT JOIN public.sucursales s ON s.id_sucursal = e.sucursal_id
    WHERE e.equipo_id = $1
    LIMIT 1
    `,
    [equipoId]
  );

  if (equipoR.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND" });

  const miembrosR = await query<any>(
    `
    SELECT
      em.usuario_id,
      u.nombre,
      u.correo,
      em.rol_equipo,
      em.fecha_ingreso,
      em.activo
    FROM public.equipo_miembros em
    JOIN public.usuarios u ON u.id_usuario = em.usuario_id
    WHERE em.equipo_id = $1
    ORDER BY em.fecha_ingreso ASC
    `,
    [equipoId]
  );

  const e = equipoR[0];

  return res.json({
    ok: true,
    equipo: {
      equipo_id: String(e.equipo_id),
      nombre: e.nombre,
      descripcion: e.descripcion ?? null,
      lider_usuario_id: e.lider_usuario_id ?? null,
      lider_nombre: e.lider_nombre ?? null,
      sucursal_id: e.sucursal_id != null ? String(e.sucursal_id) : null,
      sucursal_nombre: e.sucursal_nombre ?? null,
      activo: Boolean(e.activo),
      created_at: e.created_at,
      updated_at: e.updated_at,
      miembros: miembrosR
        .filter((m: any) => m.activo === true)
        .map((m: any) => ({
          usuario_id: m.usuario_id,
          nombre: m.nombre,
          email: m.correo,
          rol_equipo: m.rol_equipo ?? "miembro",
          fecha_ingreso: m.fecha_ingreso,
        })),
      total_miembros: miembrosR.filter((m: any) => m.activo === true).length,
    },
  });
}));

/**
 * POST /equipos
 */
router.post("/equipos", requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { role, sucursalIdText } = await getUserContext(req);
  assertRole(role, ["admin", "gerente"]);

  const parsed = CreateEquipoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", details: parsed.error.flatten() });

  const body = parsed.data;

  let sucursalIdToUse: string | null = null;
  if (role === "gerente") {
    if (!sucursalIdText) return res.status(400).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
    sucursalIdToUse = sucursalIdText;
  } else {
    sucursalIdToUse = body.sucursal_id ?? sucursalIdText;
  }

  if (!sucursalIdToUse) return res.status(400).json({ ok: false, reason: "SUCURSAL_REQUIRED" });

  const r = await query<{ equipo_id: any }>(
    `
    INSERT INTO public.equipos (nombre, descripcion, lider_usuario_id, sucursal_id)
    VALUES ($1, $2, $3, $4)
    RETURNING equipo_id
    `,
    [body.nombre, body.descripcion ?? null, body.lider_usuario_id ?? null, sucursalIdToUse]
  );

  return res.status(201).json({ ok: true, equipo_id: String(r[0]?.equipo_id) });
}));

/**
 * PATCH /equipos/:id
 */
router.patch("/equipos/:id", requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { role, sucursalIdText } = await getUserContext(req);
  assertRole(role, ["admin", "gerente"]);

  const equipoId = String(req.params.id ?? "").trim();
  if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });

  const parsed = UpdateEquipoSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", details: parsed.error.flatten() });

  const body = parsed.data;

  if (role === "gerente") {
    if (!sucursalIdText) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
    const ok = await query<{ ok: number }>(
      `SELECT 1 as ok FROM public.equipos WHERE equipo_id = $1 AND sucursal_id::text = $2 LIMIT 1`,
      [equipoId, sucursalIdText]
    );
    if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
  }

  const sets: string[] = [];
  const args: any[] = [];
  let idx = 1;

  if (body.nombre !== undefined) { sets.push(`nombre = $${idx++}`); args.push(body.nombre); }
  if (body.descripcion !== undefined) { sets.push(`descripcion = $${idx++}`); args.push(body.descripcion); }
  if (body.lider_usuario_id !== undefined) { sets.push(`lider_usuario_id = $${idx++}`); args.push(body.lider_usuario_id); }
  if (body.activo !== undefined) { sets.push(`activo = $${idx++}`); args.push(body.activo); }

  if (body.sucursal_id !== undefined) {
    if (role !== "admin") return res.status(403).json({ ok: false, reason: "FORBIDDEN_SUCURSAL_CHANGE" });
    if (!body.sucursal_id) return res.status(400).json({ ok: false, reason: "SUCURSAL_REQUIRED" });
    sets.push(`sucursal_id = $${idx++}`);
    args.push(body.sucursal_id);
  }

  if (sets.length === 0) return res.status(400).json({ ok: false, reason: "NO_FIELDS" });

  args.push(equipoId);

  const r = await query<{ equipo_id: any }>(
    `
    UPDATE public.equipos
    SET ${sets.join(", ")}
    WHERE equipo_id = $${idx++}
    RETURNING equipo_id
    `,
    args
  );

  if (r.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND" });
  return res.json({ ok: true, equipo_id: String(r[0].equipo_id) });
}));

/**
 * DELETE /equipos/:id (soft)
 */
router.delete("/equipos/:id", requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { role } = await getUserContext(req);
  assertRole(role, ["admin"]);

  const equipoId = String(req.params.id ?? "").trim();
  if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });

  const r = await query<{ equipo_id: any }>(
    `UPDATE public.equipos SET activo = FALSE WHERE equipo_id = $1 RETURNING equipo_id`,
    [equipoId]
  );

  if (r.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND" });
  return res.json({ ok: true, equipo_id: String(r[0].equipo_id) });
}));

/**
 * POST /equipos/:id/miembros
 */
router.post("/equipos/:id/miembros", requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { role, sucursalIdText } = await getUserContext(req);
  assertRole(role, ["admin", "gerente"]);

  const equipoId = String(req.params.id ?? "").trim();
  if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });

  const parsed = AddMiembroSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", details: parsed.error.flatten() });

  const body = parsed.data;

  if (role === "gerente") {
    if (!sucursalIdText) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
    const ok = await query<{ ok: number }>(
      `SELECT 1 as ok FROM public.equipos WHERE equipo_id = $1 AND sucursal_id::text = $2 LIMIT 1`,
      [equipoId, sucursalIdText]
    );
    if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
  }

  const u = await query<{ ok: number }>(
    `SELECT 1 as ok FROM public.usuarios WHERE id_usuario = $1::uuid LIMIT 1`,
    [body.usuario_id]
  );
  if (u.length === 0) return res.status(400).json({ ok: false, reason: "USUARIO_NOT_FOUND" });

  const r = await query<{ equipo_id: any; usuario_id: string }>(
    `
    INSERT INTO public.equipo_miembros (equipo_id, usuario_id, rol_equipo, activo)
    VALUES ($1, $2::uuid, $3, TRUE)
    ON CONFLICT (equipo_id, usuario_id)
    DO UPDATE SET
      rol_equipo = EXCLUDED.rol_equipo,
      activo = TRUE
    RETURNING equipo_id, usuario_id
    `,
    [equipoId, body.usuario_id, body.rol_equipo ?? "miembro"]
  );

  return res.status(201).json({ ok: true, equipo_id: String(r[0].equipo_id), usuario_id: r[0].usuario_id });
}));

/**
 * DELETE /equipos/:id/miembros/:usuario_id
 */
router.delete("/equipos/:id/miembros/:usuario_id", requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { role, sucursalIdText } = await getUserContext(req);
  assertRole(role, ["admin", "gerente"]);

  const equipoId = String(req.params.id ?? "").trim();
  const miembroId = String(req.params.usuario_id ?? "").trim();

  if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });
  if (!/^[0-9a-fA-F-]{36}$/.test(miembroId)) return res.status(400).json({ ok: false, reason: "BAD_USUARIO_ID" });

  if (role === "gerente") {
    if (!sucursalIdText) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
    const ok = await query<{ ok: number }>(
      `SELECT 1 as ok FROM public.equipos WHERE equipo_id = $1 AND sucursal_id::text = $2 LIMIT 1`,
      [equipoId, sucursalIdText]
    );
    if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
  }

  const r = await query<{ equipo_id: any; usuario_id: string }>(
    `
    UPDATE public.equipo_miembros
    SET activo = FALSE
    WHERE equipo_id = $1
      AND usuario_id = $2::uuid
    RETURNING equipo_id, usuario_id
    `,
    [equipoId, miembroId]
  );

  if (r.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND" });
  return res.json({ ok: true, equipo_id: String(r[0].equipo_id), usuario_id: r[0].usuario_id });
}));

/**
 * Error handler SOLO para este router: siempre JSON.
 */
router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(err?.status ?? 500);
  const code = String(err?.code ?? err?.message ?? "INTERNAL_ERROR");
  if (status === 401) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (status === 403) return res.status(403).json({ ok: false, reason: code === "FORBIDDEN" ? "FORBIDDEN" : code });
  if (status === 404) return res.status(404).json({ ok: false, reason: code });
  return res.status(500).json({ ok: false, reason: "INTERNAL_ERROR" });
});

export default router;

