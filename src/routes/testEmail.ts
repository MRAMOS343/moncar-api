// src/routes/testEmail.ts
import { Router } from "express";
import { sendEmail } from "../services/mailer/sendEmail";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole } from "../middleware/requireRole";
import { asyncHandler } from "../utils/http";

const router = Router();

/**
 * POST /admin/test-email
 * Solo admins — envía un correo de prueba end-to-end.
 */
router.post(
  "/admin/test-email",
  requireAuth,
  requireRole(["admin"]),
  asyncHandler(async (req, res) => {
    const { to } = req.body as { to: string };

    if (!to) {
      res.status(400).json({ error: "El campo 'to' es requerido" });
      return;
    }

    await sendEmail({
      to,
      subject: "Prueba Resend - MonCAR",
      html: "<h1>Hola</h1><p>Correo de prueba desde el backend.</p>",
      text: "Correo de prueba desde el backend.",
      tags: [{ name: "env", value: process.env.NODE_ENV || "dev" }],
    });

    res.json({ ok: true });
  })
);

export default router;
