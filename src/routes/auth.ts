import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/requireAuth";
import { query } from "../db";

const router = Router();

const MAX_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? 8);
const LOCK_MINUTES = Number(process.env.AUTH_LOCK_MINUTES ?? 15);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";

function nowIso() {
  return new Date().toISOString();
}

/**
 * POST /auth/login
 * Body: { email, password }  (también acepto { correo, password } por compatibilidad)
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

    const u = rows[0];
    if (!u || !u.activo) {
      // No revelar si existe o no
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

    const passwordOk = await bcrypt.compare(password, u.password_hash);
    if (!passwordOk) {
      // Incremento de intentos + lockout si alcanza MAX_ATTEMPTS
      const nextAttempts = Number(u.failed_login_attempts ?? 0) + 1;
      const shouldLock = nextAttempts >= MAX_ATTEMPTS;

      await query(
        `
        UPDATE usuarios
        SET
          failed_login_attempts = $2,
          locked_until = CASE
            WHEN $3 THEN (now() + ($4 || ' minutes')::interval)
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

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, error: "SERVER_MISCONFIG_JWT_SECRET" });
    }

    const token = jwt.sign(
      {
        sub: String(u.id_usuario),
        rol: String(u.rol ?? "cajero"),
        sucursal_id: u.sucursal_id ? String(u.sucursal_id) : undefined,
        correo: String(u.correo),
      },
      secret,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Respuesta compatible con tu frontend actual
    const user = {
      id: String(u.id_usuario),
      nombre: String(u.nombre),
      email: String(u.correo),
      role: String(u.rol ?? "cajero"),
      // Extras útiles para UI futura:
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

    const u = rows[0];
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

