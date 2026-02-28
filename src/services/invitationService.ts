// src/services/invitationService.ts
import { query, withTransaction } from "../db";
import { logger } from "../logger";
import bcrypt from "bcryptjs";

export interface CreateUserInput {
  nombre: string;
  correo: string;
  rol: string;
  sucursal_id?: string | null;
  invited_by: string;
}

export class InvitationService {
  async createInvitation(
    input: CreateUserInput
  ): Promise<{ token: string; usuario_id: string }> {
    return withTransaction(async (client) => {
      // 1. Verificar que el correo no exista ya
      const existing = await client.query(
        "SELECT id_usuario FROM usuarios WHERE lower(correo) = lower($1)",
        [input.correo]
      );
      if (existing.rows[0]) throw new Error("EMAIL_ALREADY_EXISTS");

      // 2. Crear usuario INACTIVO, sin password
      const usuResult = await client.query(
        `INSERT INTO usuarios
           (nombre, correo, rol, sucursal_id, activo, must_change_password, invited_by)
         VALUES ($1, lower($2), $3, $4, false, true, $5)
         RETURNING id_usuario`,
        [
          input.nombre,
          input.correo,
          input.rol,
          input.sucursal_id ?? null,
          input.invited_by,
        ]
      );
      const usuario_id = usuResult.rows[0].id_usuario;

      // 3. Crear token con expiración de 48 hrs
      const tokenResult = await client.query(
        `INSERT INTO invitation_tokens (usuario_id, tipo)
         VALUES ($1, 'invitation') RETURNING token`,
        [usuario_id]
      );
      const token = tokenResult.rows[0].token;

      logger.info({ usuario_id, correo: input.correo }, "invitation.created");
      return { token, usuario_id };
    });
  }

  async validateToken(
    token: string
  ): Promise<{
    valid: boolean;
    correo?: string;
    nombre?: string;
    error?: string;
  }> {
    const rows = await query(
      `SELECT t.expires_at, t.used_at, u.correo, u.nombre
       FROM invitation_tokens t
       JOIN usuarios u ON u.id_usuario = t.usuario_id
       WHERE t.token = $1 AND t.tipo = 'invitation'`,
      [token]
    );
    const inv = rows[0];
    if (!inv) return { valid: false, error: "TOKEN_INVALID" };
    if (inv.used_at) return { valid: false, error: "TOKEN_ALREADY_USED" };
    if (new Date(inv.expires_at) < new Date())
      return { valid: false, error: "TOKEN_EXPIRED" };
    return { valid: true, correo: inv.correo, nombre: inv.nombre };
  }

  async activateAccount(
    token: string,
    password: string
  ): Promise<{ ok: boolean }> {
    const validation = await this.validateToken(token);
    if (!validation.valid) throw new Error(validation.error);

    const [inv] = await query(
      "SELECT usuario_id FROM invitation_tokens WHERE token = $1",
      [token]
    );

    const hash = await bcrypt.hash(password, 12);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE usuarios SET
           password_hash = $1,
           activo = true,
           must_change_password = false,
           activated_at = now(),
           actualizado_en = now()
         WHERE id_usuario = $2`,
        [hash, inv.usuario_id]
      );
      await client.query(
        "UPDATE invitation_tokens SET used_at = now() WHERE token = $1",
        [token]
      );
    });

    logger.info({ usuario_id: inv.usuario_id }, "invitation.activated");
    return { ok: true };
  }

  async resendInvitation(usuario_id: string): Promise<{ token: string }> {
    const [usuario] = await query(
      "SELECT correo, activo FROM usuarios WHERE id_usuario = $1",
      [usuario_id]
    );
    if (!usuario) throw new Error("USER_NOT_FOUND");
    if (usuario.activo) throw new Error("USER_ALREADY_ACTIVE");

    return withTransaction(async (client) => {
      // Invalidar tokens anteriores
      await client.query(
        `UPDATE invitation_tokens SET used_at = now()
         WHERE usuario_id = $1 AND tipo = 'invitation' AND used_at IS NULL`,
        [usuario_id]
      );

      const result = await client.query(
        `INSERT INTO invitation_tokens (usuario_id, tipo)
         VALUES ($1, 'invitation') RETURNING token`,
        [usuario_id]
      );
      return { token: result.rows[0].token };
    });
  }
}

export const invitationService = new InvitationService();
