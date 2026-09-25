import { useCallback, useEffect, useState } from 'react';
import { api, forgetToken, readToken, SessionExpired } from './api';
import { ReportDetail } from './ReportDetail';
import { ReportQueue } from './ReportQueue';
import { SignIn } from './SignIn';
import type { Admin, ReportDetail as Report, ReportPage } from './types';

type Status = 'open' | 'resolved';

export function App() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [booting, setBooting] = useState(true);
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
    if (admin === null) return;
    void reload();
  }, [admin, reload]);

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
    </div>
  );
}
