// src/services/mailer/sendEmail.ts
import { resend, getFromAddress, getReplyToAddress } from "./resend";
import { logger } from "../../logger";

type SendEmailArgs = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  tags?: { name: string; value: string }[];
};

export async function sendEmail(args: SendEmailArgs) {
  const from = getFromAddress();
  const replyTo = getReplyToAddress();

  try {
    const resp = await resend.emails.send({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo,
      tags: args.tags,
    });

    logger.info({ resp }, "email_sent");

    return resp;
  } catch (err: any) {
    logger.error(
      { error: err?.message || String(err) },
      "email_send_failed"
    );
    throw err;
  }
}
