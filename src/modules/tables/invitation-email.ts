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

/// One message whoever receives it: the link no longer cares which account
/// opens it, so there is nothing to tell an unknown mailbox that a known one
/// would not need too.
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
      `Ouvre ce lien depuis ton téléphone : ${input.acceptUrl}`,
      '',
      'Il t’emmène dans Questbook, ou vers le store pour l’installer si tu ne l’as pas encore.',
      'Ce lien est personnel et ne sert qu’une fois : une fois la table rejointe, il ne fonctionne plus.',
    ].join('\n'),
    html: `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:24px;background:#f4ecd8;font-family:Georgia,serif;color:#2b2118">
    <div style="max-width:520px;margin:0 auto;background:#fbf6ea;border:3px solid #6b4f2a;border-radius:10px;padding:28px">
      <h1 style="margin:0 0 16px;font-size:20px">Une table t'attend sur Questbook</h1>
      <p style="margin:0 0 16px;line-height:1.5">
        <strong>${inviter}</strong> t'invite à rejoindre sa table
        <strong>« ${title} »</strong>.
      </p>
      <p style="margin:0 0 24px">
        <a href="${url}" style="display:inline-block;background:#c8912f;color:#2b2118;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">
          Rejoindre la table
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#6b5c48;line-height:1.5">
        Ouvre ce lien depuis ton téléphone : il t'emmène dans Questbook, ou
        vers le store pour l'installer si tu ne l'as pas encore.
      </p>
      <p style="margin:0;font-size:13px;color:#6b5c48;line-height:1.5">
        Ce lien est personnel et ne sert qu'une fois.
      </p>
    </div>
  </body>
</html>`,
  };
}
