// src/services/mailer/resend.ts
import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY;
if (!resendApiKey) throw new Error("RESEND_API_KEY no está definida");

export const resend = new Resend(resendApiKey);

/**
 * Devuelve la dirección "from" configurada.
 * Soporta RESEND_FROM (preferido) o EMAIL_FROM (legacy).
 */
export function getFromAddress(): string {
  const from = process.env.RESEND_FROM || process.env.EMAIL_FROM;
  if (!from) throw new Error("RESEND_FROM / EMAIL_FROM no está definida");
  return from;
}

export function getReplyToAddress(): string | undefined {
  return process.env.RESEND_REPLY_TO || undefined;
}
