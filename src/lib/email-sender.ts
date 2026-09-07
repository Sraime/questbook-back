import type { FastifyBaseLogger } from 'fastify';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/// Abstracted for the same reason as `GoogleVerifier`: tests must be able to
/// assert on what would have been sent without reaching the network.
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/// Resend's REST API is called directly rather than through their SDK: one
/// `fetch` against a documented endpoint is less to carry than a dependency,
/// and this codebase deliberately keeps its dependency list short.
export function createResendEmailSender(options: {
  apiKey: string;
  from: string;
  logger: FastifyBaseLogger;
}): EmailSender {
  return {
    async send(message) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });

      if (!response.ok) {
        // The body carries Resend's own error code, which is the only useful
        // thing to look at when a domain is not verified yet.
        const body = await response.text();
        throw new Error(`Resend refused the message (${response.status}): ${body}`);
      }
    },
  };
}

/// Used whenever `RESEND_API_KEY` is unset, so a developer can exercise the
/// whole invitation flow — link included — without an email account.
export function createLoggingEmailSender(logger: FastifyBaseLogger): EmailSender {
  return {
    async send(message) {
      logger.info(
        { to: message.to, subject: message.subject, text: message.text },
        'Email not sent: no RESEND_API_KEY configured',
      );
    },
  };
}
