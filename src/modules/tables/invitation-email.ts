import type { EmailMessage } from '../../lib/email-sender.js';

export interface InvitationEmailInput {
  to: string;
  tableTitle: string;
  inviterName: string;
  acceptUrl: string;
}

/// Escapes the values interpolated into the HTML body. A table title is
/// free text chosen by another user, so it reaches this template untrusted.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderInvitationEmail(input: InvitationEmailInput): EmailMessage {
  const title = escapeHtml(input.tableTitle);
  const inviter = escapeHtml(input.inviterName);
  const url = escapeHtml(input.acceptUrl);

  return {
    to: input.to,
    subject: `${input.inviterName} t'invite à rejoindre « ${input.tableTitle} »`,
    text: [
      `${input.inviterName} t'invite à rejoindre sa table « ${input.tableTitle} » sur Questbook.`,
      '',
      `Pour accepter : ${input.acceptUrl}`,
      '',
      "Tu peux aussi ouvrir l'application, l'invitation t'y attend dans l'onglet Tables.",
    ].join('\n'),
    html: `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:24px;background:#f4ecd8;font-family:Georgia,serif;color:#2b2118">
    <div style="max-width:520px;margin:0 auto;background:#fbf6ea;border:3px solid #6b4f2a;border-radius:10px;padding:28px">
      <h1 style="margin:0 0 16px;font-size:20px">Une nouvelle table t'attend</h1>
      <p style="margin:0 0 16px;line-height:1.5">
        <strong>${inviter}</strong> t'invite à rejoindre sa table
        <strong>« ${title} »</strong> sur Questbook.
      </p>
      <p style="margin:0 0 24px">
        <a href="${url}" style="display:inline-block;background:#c8912f;color:#2b2118;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">
          Accepter l'invitation
        </a>
      </p>
      <p style="margin:0;font-size:13px;color:#6b5c48;line-height:1.5">
        Tu peux aussi ouvrir l'application : l'invitation t'attend dans l'onglet Tables.
      </p>
    </div>
  </body>
</html>`,
  };
}
