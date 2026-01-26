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

function isUuidLike(s: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(String(s ?? "").trim());
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

/**
 * Capabilities del esquema real de la tabla equipos.
 * Esto hace el router robusto durante la migración (cuando existen ambas columnas,
 * o cuando sucursal_id sigue siendo NOT NULL).
 */
type EquipoSchemaCaps = {
  hasSucursalCodigo: boolean;
  sucursalCodigoNotNull: boolean;

  hasSucursalId: boolean;
  sucursalIdNotNull: boolean;

  hasUpdatedAt: boolean; // updated_at
};

let capsPromise: Promise<EquipoSchemaCaps> | null = null;

async function getEquipoSchemaCaps(): Promise<EquipoSchemaCaps> {
  if (capsPromise) return capsPromise;

  capsPromise = (async () => {
    const cols = await query<{ column_name: string; is_nullable: string }>(
      `
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'equipos'
      `,
      []
    );

    const byName = new Map<string, string>();
    for (const c of cols) byName.set(String(c.column_name), String(c.is_nullable));

    const hasSucursalCodigo = byName.has("sucursal_codigo");
    const sucursalCodigoNotNull = hasSucursalCodigo ? byName.get("sucursal_codigo") === "NO" : false;

    const hasSucursalId = byName.has("sucursal_id");
    const sucursalIdNotNull = hasSucursalId ? byName.get("sucursal_id") === "NO" : false;

    const hasUpdatedAt = byName.has("updated_at");

    return {
      hasSucursalCodigo,
      sucursalCodigoNotNull,
      hasSucursalId,
      sucursalIdNotNull,
      hasUpdatedAt,
    };
  })();

  return capsPromise;
}

/**
 * Contexto del usuario:
 * - sucursalCodigo: útil para gerente (filtrado y creación)
 * - sucursalIdText: legacy (por si aún lo necesitas en fase de transición)
 */
async function getUserContext(req: Request): Promise<{
  userId: string;
  role: Role;
  sucursalCodigo: string | null;
  sucursalIdText: string | null;
}> {
  const userId = getReqUserId(req);
  if (!userId) return { userId: "", role: "user", sucursalCodigo: null, sucursalIdText: null };

  const rows = await query<{ sucursal_id: any; rol: string; sucursal_codigo: string | null }>(
    `
    SELECT
      u.sucursal_id,
      u.rol,
      s.codigo AS sucursal_codigo
    FROM public.usuarios u
    LEFT JOIN public.sucursales s
      ON s.id_sucursal = u.sucursal_id
    WHERE u.id_usuario = $1
    LIMIT 1
    `,
    [userId]
  );

  const row = rows[0];
  if (!row) throw new HttpError(401, "UNAUTHORIZED");

  const sucursalIdText = row.sucursal_id != null ? String(row.sucursal_id) : null;
  const sucursalCodigo = row.sucursal_codigo != null ? String(row.sucursal_codigo).trim() : null;

  const rolDb = String(row.rol ?? "").toLowerCase().trim();
  const role: Role =
    rolDb === "admin" || rolDb === "gerente" || rolDb === "cajero" ? (rolDb as Role) : "user";

  return { userId, role, sucursalCodigo, sucursalIdText };
}

function assertRole(role: Role, allowed: Role[]) {
  if (!allowed.includes(role)) throw new HttpError(403, "FORBIDDEN");
}

/**
 * Dado un codigo de sucursal, obtiene:
 * - id_sucursal (uuid)
 * - nombre
 * Lanza 400 si no existe.
 */
async function getSucursalByCodigo(codigo: string): Promise<{ id_sucursal: string; codigo: string; nombre: string | null }> {
  const code = String(codigo ?? "").trim();
  if (!code) throw new HttpError(400, "SUCURSAL_REQUIRED");

  const r = await query<{ id_sucursal: string; codigo: string; nombre: string | null }>(
    `
    SELECT id_sucursal::text as id_sucursal, codigo, nombre
    FROM public.sucursales
    WHERE codigo = $1
    LIMIT 1
    `,
    [code]
  );

  if (r.length === 0) throw new HttpError(400, "SUCURSAL_CODIGO_INVALIDO");
  return {
    id_sucursal: String(r[0].id_sucursal),
    codigo: String(r[0].codigo),
    nombre: r[0].nombre ?? null,
  };
}

/**
 * Compat: dado un sucursal_id (uuid), obtiene codigo.
 * Retorna null si el input no es uuid o no existe.
 */
async function resolveSucursalCodigoFromId(sucursalId: string): Promise<string | null> {
  const id = String(sucursalId ?? "").trim();
  if (!isUuidLike(id)) return null;

  const r = await query<{ codigo: string }>(
    `SELECT codigo FROM public.sucursales WHERE id_sucursal = $1::uuid LIMIT 1`,
    [id]
  );
  const code = r[0]?.codigo != null ? String(r[0].codigo).trim() : null;
  return code && code.length ? code : null;
}

async function assertEquipoVisibleByRole(params: {
  equipoId: string;
  role: Role;
  userId: string;
  sucursalCodigo: string | null;
  sucursalIdText: string | null;
}) {
  const { equipoId, role, userId, sucursalCodigo, sucursalIdText } = params;
  const caps = await getEquipoSchemaCaps();

  if (role === "admin") return;

  if (role === "gerente") {
    // Preferimos filtrar por codigo si el esquema lo soporta
    if (caps.hasSucursalCodigo) {
      if (!sucursalCodigo) throw new HttpError(403, "USER_HAS_NO_SUCURSAL");
      const ok = await query<{ ok: number }>(
        `SELECT 1 as ok
         FROM public.equipos e
         WHERE e.equipo_id = $1
           AND e.sucursal_codigo = $2
         LIMIT 1`,
        [equipoId, sucursalCodigo]
      );
      if (ok.length === 0) throw new HttpError(404, "EQUIPO_NOT_FOUND_OR_FORBIDDEN");
      return;
    }

    // Legacy: filtrar por sucursal_id::text
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
router.get(
  "/equipos",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, role, sucursalCodigo, sucursalIdText } = await getUserContext(req);
    const caps = await getEquipoSchemaCaps();

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
      if (caps.hasSucursalCodigo) {
        if (!sucursalCodigo) throw new HttpError(403, "USER_HAS_NO_SUCURSAL");
        whereParts.push(`e.sucursal_codigo = $${idx++}`);
        args.push(sucursalCodigo);
      } else {
        if (!sucursalIdText) throw new HttpError(403, "USER_HAS_NO_SUCURSAL");
        whereParts.push(`e.sucursal_id::text = $${idx++}`);
        args.push(sucursalIdText);
      }
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

    // SELECT dinámico según esquema (codigo o id)
    const selectSucursal = caps.hasSucursalCodigo
      ? `e.sucursal_codigo,
         s.nombre AS sucursal_nombre`
      : `e.sucursal_id,
         s.nombre AS sucursal_nombre`;

    const joinSucursal = caps.hasSucursalCodigo
      ? `LEFT JOIN public.sucursales s ON s.codigo = e.sucursal_codigo`
      : `LEFT JOIN public.sucursales s ON s.id_sucursal = e.sucursal_id`;

    const sql = `
      SELECT
        e.equipo_id,
        e.nombre,
        e.descripcion,
        e.lider_usuario_id,
        u.nombre AS lider_nombre,
        ${selectSucursal},
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
      ${joinSucursal}
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
      // Devolvemos ambos campos si están presentes (para compat)
      sucursal_codigo: row.sucursal_codigo ?? null,
      sucursal_id: row.sucursal_id != null ? String(row.sucursal_id) : null,
      sucursal_nombre: row.sucursal_nombre ?? null,
      activo: Boolean(row.activo),
      created_at: row.created_at,
      updated_at: row.updated_at,
      total_miembros: Number(row.total_miembros ?? 0),
    }));

    const next_cursor = items.length ? items[items.length - 1].equipo_id : null;
    return res.json({ ok: true, items, next_cursor });
  })
);

/**
 * GET /equipos/:id
 */
router.get(
  "/equipos/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, role, sucursalCodigo, sucursalIdText } = await getUserContext(req);
    const caps = await getEquipoSchemaCaps();

    const equipoId = String(req.params.id ?? "").trim();
    if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });

    await assertEquipoVisibleByRole({ equipoId, role, userId, sucursalCodigo, sucursalIdText });

    const selectSucursal = caps.hasSucursalCodigo
      ? `e.sucursal_codigo,
         s.nombre AS sucursal_nombre`
      : `e.sucursal_id,
         s.nombre AS sucursal_nombre`;

    const joinSucursal = caps.hasSucursalCodigo
      ? `LEFT JOIN public.sucursales s ON s.codigo = e.sucursal_codigo`
      : `LEFT JOIN public.sucursales s ON s.id_sucursal = e.sucursal_id`;

    const equipoR = await query<any>(
      `
      SELECT
        e.equipo_id,
        e.nombre,
        e.descripcion,
        e.lider_usuario_id,
        u.nombre AS lider_nombre,
        ${selectSucursal},
        e.activo,
        e.created_at,
        e.updated_at
      FROM public.equipos e
      LEFT JOIN public.usuarios u ON u.id_usuario = e.lider_usuario_id
      ${joinSucursal}
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
        sucursal_codigo: e.sucursal_codigo ?? null,
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
  })
);

/**
 * POST /equipos
 *
 * Objetivo: escribir sucursal_codigo (nuevo).
 * Importante: si tu tabla aún tiene sucursal_id NOT NULL, este router también llenará sucursal_id
 * derivándolo del codigo (lookup en sucursales).
 */
router.post(
  "/equipos",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { role, sucursalCodigo: userSucursalCodigo, sucursalIdText: userSucursalIdText } = await getUserContext(req);
    const caps = await getEquipoSchemaCaps();
    assertRole(role, ["admin", "gerente"]);

    const parsed = CreateEquipoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    // 1) Determinar sucursal_codigo a usar
    let codigoToUse: string | null = null;

    if (role === "gerente") {
      if (!userSucursalCodigo) return res.status(400).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
      codigoToUse = userSucursalCodigo;
    } else {
      codigoToUse = (body as any).sucursal_codigo ?? null;

      if (!codigoToUse && (body as any).sucursal_id) {
        codigoToUse = await resolveSucursalCodigoFromId((body as any).sucursal_id);
      }

      if (!codigoToUse && userSucursalCodigo) codigoToUse = userSucursalCodigo;

      // fallback extremo: admin sin codigo pero con sucursal_id en user
      if (!codigoToUse && userSucursalIdText) {
        codigoToUse = await resolveSucursalCodigoFromId(userSucursalIdText);
      }
    }

    if (!codigoToUse) return res.status(400).json({ ok: false, reason: "SUCURSAL_REQUIRED" });

    // 2) Lookup sucursal (id y nombre) para poder:
    // - validar existencia (400)
    // - llenar sucursal_id si sigue siendo NOT NULL
    const suc = await getSucursalByCodigo(codigoToUse);

    // 3) Insert con columnas según esquema real
    const cols: string[] = ["nombre", "descripcion", "lider_usuario_id"];
    const vals: string[] = [];
    const args: any[] = [body.nombre, body.descripcion ?? null, body.lider_usuario_id ?? null];
    let i = 1;

    vals.push(`$${i++}`, `$${i++}`, `$${i++}`);

    if (caps.hasSucursalCodigo) {
      cols.push("sucursal_codigo");
      args.push(suc.codigo);
      vals.push(`$${i++}`);
    }

    // Si la tabla aún exige sucursal_id (NOT NULL), llenarla también.
    if (caps.hasSucursalId && caps.sucursalIdNotNull) {
      cols.push("sucursal_id");
      args.push(suc.id_sucursal); // texto uuid, lo casteamos en SQL
      vals.push(`$${i++}::uuid`);
    }

    // Si NO existe sucursal_codigo todavía, seguimos en legacy
    if (!caps.hasSucursalCodigo && caps.hasSucursalId) {
      // Admin/gerente siguen creando por sucursal_id:
      // Preferimos suc.id_sucursal
      cols.push("sucursal_id");
      args.push(suc.id_sucursal);
      vals.push(`$${i++}::uuid`);
    }

    const sql = `
      INSERT INTO public.equipos (${cols.join(", ")})
      VALUES (${vals.join(", ")})
      RETURNING equipo_id
    `;

    const r = await query<{ equipo_id: any }>(sql, args);
    return res.status(201).json({ ok: true, equipo_id: String(r[0]?.equipo_id) });
  })
);

/**
 * PATCH /equipos/:id
 */
router.patch(
  "/equipos/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { role, sucursalCodigo: userSucursalCodigo, sucursalIdText: userSucursalIdText } = await getUserContext(req);
    const caps = await getEquipoSchemaCaps();
    assertRole(role, ["admin", "gerente"]);

    const equipoId = String(req.params.id ?? "").trim();
    if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });

    const parsed = UpdateEquipoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    // gerente: solo puede editar dentro de su sucursal
    if (role === "gerente") {
      if (caps.hasSucursalCodigo) {
        if (!userSucursalCodigo) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
        const ok = await query<{ ok: number }>(
          `SELECT 1 as ok
           FROM public.equipos
           WHERE equipo_id = $1
             AND sucursal_codigo = $2
           LIMIT 1`,
          [equipoId, userSucursalCodigo]
        );
        if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
      } else {
        if (!userSucursalIdText) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
        const ok = await query<{ ok: number }>(
          `SELECT 1 as ok
           FROM public.equipos
           WHERE equipo_id = $1
             AND sucursal_id::text = $2
           LIMIT 1`,
          [equipoId, userSucursalIdText]
        );
        if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
      }
    }

    const sets: string[] = [];
    const args: any[] = [];
    let idx = 1;

    if (body.nombre !== undefined) {
      sets.push(`nombre = $${idx++}`);
      args.push(body.nombre);
    }
    if (body.descripcion !== undefined) {
      sets.push(`descripcion = $${idx++}`);
      args.push(body.descripcion);
    }
    if (body.lider_usuario_id !== undefined) {
      sets.push(`lider_usuario_id = $${idx++}`);
      args.push(body.lider_usuario_id);
    }
    if (body.activo !== undefined) {
      sets.push(`activo = $${idx++}`);
      args.push(body.activo);
    }

    // Cambio de sucursal: solo admin
    // Preferimos body.sucursal_codigo; compat con body.sucursal_id.
    if ((body as any).sucursal_codigo !== undefined || (body as any).sucursal_id !== undefined) {
      if (role !== "admin") return res.status(403).json({ ok: false, reason: "FORBIDDEN_SUCURSAL_CHANGE" });

      let codigoNew: string | null = (body as any).sucursal_codigo ?? null;

      if (!codigoNew && (body as any).sucursal_id) {
        codigoNew = await resolveSucursalCodigoFromId((body as any).sucursal_id);
      }

      // fallback: si admin mandó vacío, intentar con sucursal del user (solo si tiene)
      if (!codigoNew && userSucursalCodigo) codigoNew = userSucursalCodigo;
      if (!codigoNew && userSucursalIdText) codigoNew = await resolveSucursalCodigoFromId(userSucursalIdText);

      if (!codigoNew) return res.status(400).json({ ok: false, reason: "SUCURSAL_REQUIRED" });

      const suc = await getSucursalByCodigo(codigoNew);

      if (caps.hasSucursalCodigo) {
        sets.push(`sucursal_codigo = $${idx++}`);
        args.push(suc.codigo);
      }

      // Si aún existe sucursal_id y/o es NOT NULL, mantenla consistente
      if (caps.hasSucursalId) {
        sets.push(`sucursal_id = $${idx++}::uuid`);
        args.push(suc.id_sucursal);
      }
    }

    if (sets.length === 0) return res.status(400).json({ ok: false, reason: "NO_FIELDS" });

    if (caps.hasUpdatedAt) {
      sets.push(`updated_at = now()`);
    }

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
  })
);

/**
 * DELETE /equipos/:id (soft)
 */
router.delete(
  "/equipos/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { role } = await getUserContext(req);
    const caps = await getEquipoSchemaCaps();
    assertRole(role, ["admin"]);

    const equipoId = String(req.params.id ?? "").trim();
    if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });

    const r = await query<{ equipo_id: any }>(
      `UPDATE public.equipos
       SET activo = FALSE${caps.hasUpdatedAt ? ", updated_at = now()" : ""}
       WHERE equipo_id = $1
       RETURNING equipo_id`,
      [equipoId]
    );

    if (r.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND" });
    return res.json({ ok: true, equipo_id: String(r[0].equipo_id) });
  })
);

/**
 * POST /equipos/:id/miembros
 */
router.post(
  "/equipos/:id/miembros",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { role, sucursalCodigo: userSucursalCodigo, sucursalIdText: userSucursalIdText, userId } = await getUserContext(req);
    const caps = await getEquipoSchemaCaps();
    assertRole(role, ["admin", "gerente"]);

    const equipoId = String(req.params.id ?? "").trim();
    if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });

    const parsed = AddMiembroSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, reason: "VALIDATION_ERROR", details: parsed.error.flatten() });
    }
    const body = parsed.data;

    if (role === "gerente") {
      if (caps.hasSucursalCodigo) {
        if (!userSucursalCodigo) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
        const ok = await query<{ ok: number }>(
          `SELECT 1 as ok
           FROM public.equipos
           WHERE equipo_id = $1
             AND sucursal_codigo = $2
           LIMIT 1`,
          [equipoId, userSucursalCodigo]
        );
        if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
      } else {
        if (!userSucursalIdText) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
        const ok = await query<{ ok: number }>(
          `SELECT 1 as ok
           FROM public.equipos
           WHERE equipo_id = $1
             AND sucursal_id::text = $2
           LIMIT 1`,
          [equipoId, userSucursalIdText]
        );
        if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
      }
    }

    const u = await query<{ ok: number }>(
      `SELECT 1 as ok FROM public.usuarios WHERE id_usuario = $1::uuid LIMIT 1`,
      [body.usuario_id]
    );
    if (u.length === 0) return res.status(400).json({ ok: false, reason: "USUARIO_NOT_FOUND" });

    // OJO: aquí estaba el bug en la versión anterior: faltaba pasar body.usuario_id.
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

    return res.status(201).json({
      ok: true,
      equipo_id: String(r[0].equipo_id),
      usuario_id: r[0].usuario_id,
    });
  })
);

/**
 * DELETE /equipos/:id/miembros/:usuario_id
 */
router.delete(
  "/equipos/:id/miembros/:usuario_id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { role, sucursalCodigo: userSucursalCodigo, sucursalIdText: userSucursalIdText } = await getUserContext(req);
    const caps = await getEquipoSchemaCaps();
    assertRole(role, ["admin", "gerente"]);

    const equipoId = String(req.params.id ?? "").trim();
    const miembroId = String(req.params.usuario_id ?? "").trim();

    if (!/^\d+$/.test(equipoId)) return res.status(400).json({ ok: false, reason: "BAD_EQUIPO_ID" });
    if (!isUuidLike(miembroId)) return res.status(400).json({ ok: false, reason: "BAD_USUARIO_ID" });

    if (role === "gerente") {
      if (caps.hasSucursalCodigo) {
        if (!userSucursalCodigo) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
        const ok = await query<{ ok: number }>(
          `SELECT 1 as ok
           FROM public.equipos
           WHERE equipo_id = $1
             AND sucursal_codigo = $2
           LIMIT 1`,
          [equipoId, userSucursalCodigo]
        );
        if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
      } else {
        if (!userSucursalIdText) return res.status(403).json({ ok: false, reason: "USER_HAS_NO_SUCURSAL" });
        const ok = await query<{ ok: number }>(
          `SELECT 1 as ok
           FROM public.equipos
           WHERE equipo_id = $1
             AND sucursal_id::text = $2
           LIMIT 1`,
          [equipoId, userSucursalIdText]
        );
        if (ok.length === 0) return res.status(404).json({ ok: false, reason: "NOT_FOUND_OR_FORBIDDEN" });
      }
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
  })
);

/**
 * Error handler SOLO para este router: siempre JSON.
 * Importante: ya maneja 400 para NO ocultar errores como INTERNAL_ERROR.
 */
router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(err?.status ?? 500);
  const code = String(err?.code ?? err?.message ?? "INTERNAL_ERROR");

  if (status === 400) return res.status(400).json({ ok: false, reason: code });
  if (status === 401) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (status === 403) return res.status(403).json({ ok: false, reason: code === "FORBIDDEN" ? "FORBIDDEN" : code });
  if (status === 404) return res.status(404).json({ ok: false, reason: code });

  // Log en servidor (para ver el error real)
  console.error("[equipos] INTERNAL_ERROR:", err);

  return res.status(500).json({ ok: false, reason: "INTERNAL_ERROR" });
});

export default router;
