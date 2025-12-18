import { Router } from "express";
import bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import type { Secret, SignOptions } from "jsonwebtoken";
import { requireAuth } from "../middleware/requireAuth";
import { query } from "../db";

const router = Router();

const MAX_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? 8);
const LOCK_MINUTES = Number(process.env.AUTH_LOCK_MINUTES ?? 15);

/**
 * jsonwebtoken v9 + @types v9: expiresIn es (number | StringValue).
 * process.env te da string “amplio”, así que:
 *  - aceptamos números puros (segundos)
 *  - aceptamos formatos ms-style: 15m, 7d, 12h, 30s, 500ms, etc.
 *  - si no cumple, fallback a "7d"
 */
function coerceExpiresIn(raw: string): SignOptions["expiresIn"] {
  const v = String(raw ?? "").trim();

  // Si es número puro -> segundos
  if (/^\d+$/.test(v)) return Number(v);

  // Formatos tipo ms: 15m, 7d, 12h, 30s, 500ms, etc.
  if (/^\d+(ms|s|m|h|d|w|y)$/.test(v)) {
    return v as unknown as SignOptions["expiresIn"];
  }

  // Fallback seguro
  return "7d" as unknown as SignOptions["expiresIn"];
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * POST /auth/login
 * Body: { email, password }  (también acepta { correo, password })
 * 200: { token, user, must_change_password }
 * 401: credenciales inválidas
 * 423: cuenta bloqueada temporalmente
 */
router.post("/auth/login", async (req, res) => {
  const emailRaw = (req.body?.email ?? req.body?.correo ?? "") as string;
  const password = (req.body?.password ?? "") as string;

  const correo = String(emailRaw).trim().toLowerCase();
  if (!correo || !password) {
    return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
  }

  try {
    const rows = await query(
      `
      SELECT
        id_usuario,
        nombre,
        correo,
        telefono,
        avatar_url,
        sucursal_id,
        password_hash,
        activo,
        rol,
        must_change_password,
        password_updated_at,
        failed_login_attempts,
        locked_until
      FROM usuarios
      WHERE lower(correo) = lower($1)
      LIMIT 1
      `,
      [correo]
    );

    const u = rows?.[0];

    // No revelar si existe o no
    if (!u || !u.activo) {
      return res.status(401).json({ ok: false, error: "INVALID_CREDENTIALS" });
    }

    // Lock check
    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      return res.status(423).json({
        ok: false,
        error: "ACCOUNT_LOCKED",
        locked_until: u.locked_until,
      });
    }

    const passwordOk = await bcrypt.compare(password, String(u.password_hash));
    if (!passwordOk) {
      const nextAttempts = Number(u.failed_login_attempts ?? 0) + 1;
      const shouldLock = nextAttempts >= MAX_ATTEMPTS;

      await query(
        `
        UPDATE usuarios
        SET
          failed_login_attempts = $2,
          locked_until = CASE
            WHEN $3 THEN (now() + ($4 * interval '1 minute'))
            ELSE NULL
          END,
          actualizado_en = now()
        WHERE id_usuario = $1
        `,
        [u.id_usuario, nextAttempts, shouldLock, LOCK_MINUTES]
      );

      return res.status(401).json({ ok: false, error: "INVALID_CREDENTIALS" });
    }

    // Login OK → reset lock/attempts + auditoría
    const userAgent = String(req.header("user-agent") ?? "").slice(0, 512);
    const ip = String(req.ip ?? "").slice(0, 64);

    await query(
      `
      UPDATE usuarios
      SET
        failed_login_attempts = 0,
        locked_until = NULL,
        last_login_at = now(),
        last_login_ip = $2,
        last_login_user_agent = $3,
        actualizado_en = now()
      WHERE id_usuario = $1
      `,
      [u.id_usuario, ip, userAgent]
    );

    const secretStr = process.env.JWT_SECRET;
    if (!secretStr) {
      return res
        .status(500)
        .json({ ok: false, error: "SERVER_MISCONFIG_JWT_SECRET" });
    }
    const secret: Secret = secretStr;

    const payload = {
      sub: String(u.id_usuario),
      rol: String(u.rol ?? "cajero"),
      sucursal_id: u.sucursal_id ? String(u.sucursal_id) : undefined,
      correo: String(u.correo),
    };

    const signOptions: SignOptions = {
      expiresIn: coerceExpiresIn(process.env.JWT_EXPIRES_IN ?? "7d"),
    };

    // ✅ Con esto TS ya elige el overload correcto
    const token = jwt.sign(payload, secret, signOptions);

    const user = {
      id: String(u.id_usuario),
      nombre: String(u.nombre),
      email: String(u.correo),
      role: String(u.rol ?? "cajero"),
      telefono: u.telefono ?? null,
      avatar_url: u.avatar_url ?? null,
      sucursal_id: u.sucursal_id ?? null,
      last_login_at: nowIso(),
    };

    return res.json({
      token,
      user,
      must_change_password: !!u.must_change_password,
    });
  } catch (err) {
    console.error("[auth.login] error", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

/**
 * GET /auth/me
 * Header: Authorization: Bearer <token>
 * 200: { user, must_change_password }
 */
router.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const auth = (req as any).auth as { sub: string };

    const rows = await query(
      `
      SELECT
        id_usuario,
        nombre,
        correo,
        telefono,
        avatar_url,
        sucursal_id,
        activo,
        rol,
        must_change_password,
        locked_until
      FROM usuarios
      WHERE id_usuario = $1
      LIMIT 1
      `,
      [auth.sub]
    );

    const u = rows?.[0];
    if (!u || !u.activo) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      return res.status(423).json({
        ok: false,
        error: "ACCOUNT_LOCKED",
        locked_until: u.locked_until,
      });
    }

    const user = {
      id: String(u.id_usuario),
      nombre: String(u.nombre),
      email: String(u.correo),
      role: String(u.rol ?? "cajero"),
      telefono: u.telefono ?? null,
      avatar_url: u.avatar_url ?? null,
      sucursal_id: u.sucursal_id ?? null,
    };

    return res.json({ user, must_change_password: !!u.must_change_password });
  } catch (err) {
    console.error("[auth.me] error", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

export default router;
