import { age, contentLabel, partyLabel, resolutionLabel } from './format';
import type { ReportPage, ReportSummary } from './types';

interface ReportQueueProps {
  page: ReportPage | null;
  status: 'open' | 'resolved';
  selectedId: string | null;
  onSelect: (report: ReportSummary) => void;
  onStatusChange: (status: 'open' | 'resolved') => void;
}

export function ReportQueue({
  page,
  status,
  selectedId,
  onSelect,
  onStatusChange,
}: ReportQueueProps) {
  return (
    <aside className="queue">
      <div className="queue-tabs">
        <button
          className={status === 'open' ? 'active' : ''}
          onClick={() => onStatusChange('open')}
        >
          À examiner
          {page !== null && status === 'open' && <span className="count">{page.total}</span>}
        </button>
        <button
          className={status === 'resolved' ? 'active' : ''}
          onClick={() => onStatusChange('resolved')}
        >
          Traités
        </button>
      </div>

      {page === null && <p className="muted padded">Chargement…</p>}

      {page !== null && page.items.length === 0 && (
        <p className="muted padded">
          {status === 'open' ? 'Rien à examiner. ' : 'Aucun dossier traité.'}
        </p>
      )}

      <ul>
        {page?.items.map((report) => {
          const { label, late } = age(report.createdAt);

          return (
            <li key={report.id}>
              <button
                className={report.id === selectedId ? 'selected' : ''}
                onClick={() => onSelect(report)}
              >
                <span className="row">
                  <span className="kind">{contentLabel(report.contentType)}</span>
                  {/* Vingt-quatre heures est l'engagement des conditions
                      d'utilisation. Au-dela, le dossier le dit lui-meme. */}
                  <span className={late && status === 'open' ? 'age late' : 'age'}>{label}</span>
                </span>
                <span className="who">{partyLabel(report.reportedUser)}</span>
                <span className="reason">{report.reason}</span>
                {report.status === 'resolved' && (
                  <span className="verdict">{resolutionLabel(report.resolution)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
