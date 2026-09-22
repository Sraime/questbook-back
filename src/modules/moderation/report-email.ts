import type { EmailMessage } from '../../lib/email-sender.js';

export interface ReportEmailInput {
  to: string;
  /// « Une table », « Un joueur »… ce que le signalement vise, en clair.
  kind: string;
  contentType: string;
  contentId: string;
  reason: string;
  snapshot: Record<string, string>;
  reporterEmail: string;
  reportedEmail: string;
  reportedUserId: string;
  at: Date;
}

/// Tout ce qui est interpolé ici a été écrit par un joueur — le motif du
/// signalement comme le contenu signalé. C'est même la seule chose dont on
/// soit sûr : ce mail transporte du texte hostile par construction.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderReportEmail(input: ReportEmailInput): EmailMessage {
  const entries = Object.entries(input.snapshot);

  const rows = entries
    .map(
      ([label, value]) =>
        `<tr><th align="left" style="padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</th><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  return {
    to: input.to,
    subject: 'Questbook - nouveau signalement',
    text: [
      // Pas de verbe accordé ici : « une table » et « un joueur » passeraient
      // par la même phrase, et l'une des deux serait fautive.
      'Nouveau signalement sur Questbook.',
      '',
      `Objet : ${input.kind}`,
      `Reçu le : ${input.at.toISOString()}`,
      `Signalé par : ${input.reporterEmail}`,
      `Auteur du contenu : ${input.reportedEmail} (${input.reportedUserId})`,
      `Type : ${input.contentType}`,
      `Identifiant : ${input.contentId}`,
      '',
      'Motif invoqué :',
      input.reason,
      '',
      'Le contenu au moment du signalement :',
      ...entries.map(([label, value]) => `  ${label} : ${value}`),
      '',
      "Apple attend qu'un contenu choquant disparaisse, et son auteur avec, sous 24 h.",
    ].join('\n'),
    html: `<!doctype html>
<html lang="fr">
  <body style="margin:0;padding:24px;background:#f4ecd8;font-family:Georgia,serif;color:#2b2118">
    <div style="max-width:560px;margin:0 auto;background:#fbf6ea;border:3px solid #6b4f2a;border-radius:10px;padding:28px">
      <h1 style="margin:0 0 4px;font-size:20px">Nouveau signalement</h1>
      <p style="margin:0 0 20px;font-size:13px;color:#6b5c48">
        ${escapeHtml(input.kind)} — reçu le ${escapeHtml(input.at.toISOString())}
      </p>

      <h2 style="margin:0 0 8px;font-size:15px">Motif invoqué</h2>
      <p style="margin:0 0 20px;line-height:1.5;white-space:pre-wrap">${escapeHtml(input.reason)}</p>

      <h2 style="margin:0 0 8px;font-size:15px">Le contenu au moment du signalement</h2>
      <table style="margin:0 0 20px;font-size:14px;line-height:1.5">${rows}</table>

      <h2 style="margin:0 0 8px;font-size:15px">Qui</h2>
      <table style="margin:0 0 20px;font-size:14px;line-height:1.5">
        <tr><th align="left" style="padding:4px 12px 4px 0;white-space:nowrap">Signalé par</th><td style="padding:4px 0">${escapeHtml(input.reporterEmail)}</td></tr>
        <tr><th align="left" style="padding:4px 12px 4px 0;white-space:nowrap">Auteur</th><td style="padding:4px 0">${escapeHtml(input.reportedEmail)}</td></tr>
        <tr><th align="left" style="padding:4px 12px 4px 0;white-space:nowrap">Identifiant auteur</th><td style="padding:4px 0">${escapeHtml(input.reportedUserId)}</td></tr>
        <tr><th align="left" style="padding:4px 12px 4px 0;white-space:nowrap">Contenu</th><td style="padding:4px 0">${escapeHtml(input.contentType)} · ${escapeHtml(input.contentId)}</td></tr>
      </table>

      <p style="margin:0;font-size:13px;color:#6b5c48;line-height:1.5">
        Apple attend qu'un contenu choquant disparaisse, et son auteur avec,
        sous 24 h.
      </p>
    </div>
  </body>
</html>`,
  };
}
