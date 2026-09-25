import { useState } from 'react';
import { api } from './api';
import { UserPanel } from './UserPanel';
import { age, contentLabel, formatDate, partyLabel, resolutionLabel } from './format';
import type { ReportDetail as Report, Resolution } from './types';

interface ReportDetailProps {
  report: Report;
  onChanged: (report: Report) => void;
  onError: (message: string) => void;
}

const choices: Array<{ value: Resolution; label: string; hint: string }> = [
  { value: 'dismissed', label: 'Classer sans suite', hint: 'Rien à reprocher.' },
  { value: 'warned', label: 'Avertir', hint: 'Un mot suffit.' },
  { value: 'suspended', label: 'Suspendre', hint: 'La sanction se pose ci-dessous.' },
  { value: 'deleted', label: 'Fermer le compte', hint: 'La fermeture aussi.' },
];

export function ReportDetail({ report, onChanged, onError }: ReportDetailProps) {
  const [resolution, setResolution] = useState<Resolution>('dismissed');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const resolve = async () => {
    setBusy(true);
    try {
      const updated = await api<Report>(`/admin/reports/${report.id}/resolve`, {
        method: 'POST',
        body: { resolution, ...(note.trim().length > 0 ? { note: note.trim() } : {}) },
      });
      onChanged(updated);
      setNote('');
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Impossible de trancher ce dossier.');
    } finally {
      setBusy(false);
    }
  };

  const { label: ageLabel, late } = age(report.createdAt);

  return (
    <section className="detail">
      <header>
        <h2>{contentLabel(report.contentType)}</h2>
        <p className="muted">
          Signalé le {formatDate(report.createdAt)}
          {report.status === 'open' && (
            <span className={late ? 'age late' : 'age'}> — {ageLabel}</span>
          )}
        </p>
      </header>

      <div className="block">
        <h3>Le motif</h3>
        {/* React echappe ce qu'il interpole, et c'est ici que cela compte :
            l'instantane porte, par construction, du texte ecrit par quelqu'un
            qui cherchait a nuire. Jamais de dangerouslySetInnerHTML ici. */}
        <p className="quote">{report.reason}</p>
        <p className="muted">Par {partyLabel(report.reporter)}</p>
      </div>

      <div className="block">
        <h3>Ce que le contenu disait</h3>
        <p className="muted">
          Relevé par le serveur au moment du signalement. Le contenu a pu changer depuis.
        </p>
        <dl className="snapshot">
          {Object.entries(report.snapshot).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          {Object.keys(report.snapshot).length === 0 && (
            <p className="muted">Relevé illisible — à regarder en base.</p>
          )}
        </dl>
      </div>

      {report.otherReportsOnSameUser.length > 0 && (
        <div className="block warn">
          <h3>
            {report.otherReportsOnSameUser.length} autre
            {report.otherReportsOnSameUser.length > 1 ? 's' : ''} dossier
            {report.otherReportsOnSameUser.length > 1 ? 's' : ''} sur ce compte
          </h3>
          <ul className="others">
            {report.otherReportsOnSameUser.map((other) => (
              <li key={other.id}>
                <span className="kind">{contentLabel(other.contentType)}</span>
                <span className="reason">{other.reason}</span>
                <span className="muted">
                  {formatDate(other.createdAt)}
                  {other.status === 'resolved' && ` — ${resolutionLabel(other.resolution)}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.status === 'open' ? (
        <div className="block">
          <h3>Trancher</h3>
          <div className="choices">
            {choices.map((choice) => (
              <label key={choice.value} className={resolution === choice.value ? 'on' : ''}>
                <input
                  type="radio"
                  name="resolution"
                  checked={resolution === choice.value}
                  onChange={() => setResolution(choice.value)}
                />
                <span>
                  <strong>{choice.label}</strong>
                  <em>{choice.hint}</em>
                </span>
              </label>
            ))}
          </div>

          <label className="note">
            Pour le prochain qui relira ce dossier
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Facultatif."
            />
          </label>

          <button onClick={resolve} disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer la décision'}
          </button>
        </div>
      ) : (
        <div className="block done">
          <h3>Tranché</h3>
          <p>
            <strong>{resolutionLabel(report.resolution)}</strong> le{' '}
            {formatDate(report.resolvedAt)}
            {report.resolvedBy !== null && ` par ${report.resolvedBy}`}.
          </p>
          {report.resolutionNote !== null && <p className="quote">{report.resolutionNote}</p>}
        </div>
      )}

      {/* Separe du verdict a dessein : un compte se suspend souvent pour un
          faisceau de dossiers, pas pour celui qu'on a sous les yeux. */}
      <UserPanel userId={report.reportedUser.id} onError={onError} />
    </section>
  );
}
