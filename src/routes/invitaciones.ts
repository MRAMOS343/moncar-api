// src/routes/invitaciones.ts
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler, HttpError } from "../utils/http";
import { invitationService } from "../services/invitationService";
import { emailService } from "../services/emailService";
import { query } from "../db";
import { z } from "zod";

const router = Router();

const CreateUserSchema = z.object({
  nombre: z.string().min(2).max(100),
  correo: z.string().email(),
  rol: z.enum(["admin", "gerente", "vendedor"]),
  sucursal_id: z.string().uuid().optional().nullable(),
});

const SetPasswordSchema = z.object({
  token: z.string().uuid(),
  password: z.string().min(8).max(100),
});

// POST /api/v1/admin/usuarios
router.post(
  "/admin/usuarios",
  requireAuth,
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const parsed = CreateUserSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR");

    const { token, usuario_id } = await invitationService.createInvitation({
      ...parsed.data,
      invited_by: req.user!.id,
    });

    const inviteUrl = `${process.env.FRONTEND_URL}/invitacion?token=${token}`;
    await emailService.sendInvitation({
      to: parsed.data.correo,
      nombre: parsed.data.nombre,
      inviteUrl,
    });

    res.status(201).json({ ok: true, usuario_id });
  })
);

// GET /api/v1/auth/invitation/:token
router.get(
  "/auth/invitation/:token",
  asyncHandler(async (req, res) => {
    const result = await invitationService.validateToken(String(req.params.token));
    if (!result.valid) throw new HttpError(400, result.error!);
    res.json({ ok: true, correo: result.correo, nombre: result.nombre });
  })
);

// POST /api/v1/auth/set-password
router.post(
  "/auth/set-password",
  asyncHandler(async (req, res) => {
    const parsed = SetPasswordSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR");

    await invitationService.activateAccount(
      parsed.data.token,
      parsed.data.password
    );
    res.json({ ok: true, message: "Cuenta activada. Ya puedes iniciar sesión." });
  })
);

// POST /api/v1/admin/usuarios/:id/resend-invite
router.post(
  "/admin/usuarios/:id/resend-invite",
  requireAuth,
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const { token } = await invitationService.resendInvitation(id);

    const [usuario] = await query(
      "SELECT correo, nombre FROM usuarios WHERE id_usuario = $1",
      [id]
    );
    const inviteUrl = `${process.env.FRONTEND_URL}/invitacion?token=${token}`;
    await emailService.sendInvitation({
      to: usuario.correo,
      nombre: usuario.nombre,
      inviteUrl,
    });

    res.json({ ok: true });
  })
);

export default router;
