// src/services/emailService.ts
import { sendEmail } from "./mailer";
import { logger } from "../logger";

export const emailService = {
  async sendInvitation({
    to,
    nombre,
    inviteUrl,
  }: {
    to: string;
    nombre: string;
    inviteUrl: string;
  }) {
    try {
      await sendEmail({
        to,
        subject: "Tu invitación a Moncar POS",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
            <h2 style="color:#1A3A5C">Hola, ${nombre} 👋</h2>
            <p>Fuiste invitado a usar <strong>Moncar POS</strong>.</p>
            <p>Da clic en el botón para crear tu contraseña y activar tu cuenta.
               El link expira en <strong>48 horas</strong>.</p>
            <a href="${inviteUrl}"
               style="display:inline-block;background:#2471A3;color:#fff;
                      padding:12px 24px;border-radius:6px;text-decoration:none;
                      font-weight:bold;margin:16px 0">
              Activar mi cuenta
            </a>
            <p style="color:#888;font-size:12px">
              Si no esperabas esta invitación, ignora este correo.
            </p>
          </div>
        `,
        tags: [{ name: "type", value: "invitation" }],
      });
      logger.info({ to }, "email.invitation.sent");
    } catch (err) {
      // No fallar el request si el correo falla — loggear y continuar
      logger.error({ err, to }, "email.invitation.failed");
    }
  },
};
