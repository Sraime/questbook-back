import { useCallback, useEffect, useState } from 'react';
import { api, forgetToken, readToken, SessionExpired } from './api';
import { ReportDetail } from './ReportDetail';
import { ReportQueue } from './ReportQueue';
import { ScenarioCatalogue } from './ScenarioCatalogue';
import { SignIn } from './SignIn';
import { SuspendedList } from './SuspendedList';
import type { Admin, ReportDetail as Report, ReportPage } from './types';

type Status = 'open' | 'resolved';

/// Des travaux distincts, donc des vues distinctes.
///
/// Examiner un dossier et passer en revue les mesures en cours ne se font ni
/// au meme moment ni dans le meme etat d'esprit : les melanger dans la meme
/// colonne ferait de la seconde un onglet qu'on n'ouvre jamais. Ecrire le
/// catalogue est plus etranger encore — c'est du produit, pas de la
/// moderation — mais cela reclame le meme compte et la meme porte.
type View = 'reports' | 'suspended' | 'scenarios';

export function App() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>('reports');
  const [status, setStatus] = useState<Status>('open');
  const [page, setPage] = useState<ReportPage | null>(null);
  const [selected, setSelected] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signedOut = useCallback(() => {
    forgetToken();
    setAdmin(null);
    setSelected(null);
    setPage(null);
  }, []);

  /// Une erreur de session ne s'affiche pas : elle renvoie a la porte. Rien de
  /// ce qu'on pourrait dire ne permettrait de la corriger depuis cet ecran.
  const handle = useCallback(
    (cause: unknown) => {
      if (cause instanceof SessionExpired) {
        signedOut();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Quelque chose a mal tourné.');
    },
    [signedOut],
  );

  // Un rechargement de page ne doit pas redemander un code : le jeton est
  // encore dans l'onglet, et l'API dira s'il vaut encore quelque chose.
  useEffect(() => {
    if (readToken() === null) {
      setBooting(false);
      return;
    }

    api<Admin>('/admin/auth/me')
      .then(setAdmin)
      .catch(() => forgetToken())
      .finally(() => setBooting(false));
  }, []);

  const reload = useCallback(async () => {
    try {
      setPage(await api<ReportPage>(`/admin/reports?status=${status}&limit=100`));
    } catch (cause) {
      handle(cause);
    }
  }, [status, handle]);

  useEffect(() => {
    if (admin === null || view !== 'reports') return;
    void reload();
  }, [admin, view, reload]);

  const open = async (id: string) => {
    try {
      setSelected(await api<Report>(`/admin/reports/${id}`));
    } catch (cause) {
      handle(cause);
    }
  };

  const signOut = async () => {
    try {
      await api<void>('/admin/auth/session', { method: 'DELETE' });
    } catch {
      // La session part de toute facon : si l'API ne repond pas, le jeton
      // expirera seul, et insister n'aiderait personne.
    }
    signedOut();
  };

  if (booting) {
    return <main className="signin" />;
  }

  if (admin === null) {
    return <SignIn onSignedIn={setAdmin} />;
  }

  return (
    <div className="app">
      <header className="top">
        <strong>Questbook</strong>
        <span className="muted">administration</span>

        <nav className="views">
          <button
            className={view === 'reports' ? 'active' : ''}
            onClick={() => setView('reports')}
          >
            Signalements
          </button>
          <button
            className={view === 'suspended' ? 'active' : ''}
            onClick={() => setView('suspended')}
          >
            Comptes suspendus
          </button>
          <button
            className={view === 'scenarios' ? 'active' : ''}
            onClick={() => setView('scenarios')}
          >
            Scénarios
          </button>
        </nav>

        <span className="spacer" />
        <span className="muted">{admin.login}</span>
        <button className="link" onClick={signOut}>
          Fermer la session
        </button>
      </header>

      {error !== null && (
        <div className="banner" role="alert">
          {error}
          <button className="link" onClick={() => setError(null)}>
            Fermer
          </button>
        </div>
      )}

      {view === 'suspended' && <SuspendedList onError={handle} />}

      {view === 'scenarios' && <ScenarioCatalogue onError={handle} />}

      {view === 'reports' && (
      <div className="columns">
        <ReportQueue
          page={page}
          status={status}
          selectedId={selected?.id ?? null}
          onSelect={(report) => void open(report.id)}
          onStatusChange={(next) => {
            setStatus(next);
            setSelected(null);
          }}
        />

        {selected === null ? (
          <section className="detail empty">
            <p className="muted">Choisis un dossier.</p>
          </section>
        ) : (
          <ReportDetail
            report={selected}
            onChanged={(updated) => {
              setSelected(updated);
              void reload();
            }}
            onError={handle}
          />
        )}
      </div>
      )}
    </div>
  );
}
