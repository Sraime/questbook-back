import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { formatDate, partyLabel, remaining } from './format';
import type { SuspendedUser } from './types';

interface SuspendedListProps {
  onError: (cause: unknown) => void;
}

/// Qui est dehors, et depuis combien de temps.
///
/// La file des signalements ne repond pas a cette question : une fois le
/// dossier classe, le compte suspendu sort de l'ecran. Une mesure sans terme
/// n'a alors plus rien qui la rappelle a qui l'a prise.
export function SuspendedList({ onError }: SuspendedListProps) {
  const [users, setUsers] = useState<SuspendedUser[] | null>(null);
  /// Lever rend l'acces a quelqu'un qu'on avait juge nuisible : le geste se
  /// confirme. Un second clic sur le meme bouton, plutot qu'une fenetre a
  /// renvoyer — on la fermerait sans la lire.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api<SuspendedUser[]>('/admin/users/suspended'));
    } catch (cause) {
      onError(cause);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const lift = async (user: SuspendedUser) => {
    setBusy(user.id);
    try {
      await api(`/admin/users/${user.id}/suspend`, { method: 'DELETE' });
      setConfirming(null);
      await load();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(null);
    }
  };

  if (users === null) {
    return (
      <section className="suspended">
        <p className="muted padded">Chargement…</p>
      </section>
    );
  }

  if (users.length === 0) {
    return (
      <section className="suspended">
        <p className="muted padded">Aucun compte suspendu.</p>
      </section>
    );
  }

  return (
    <section className="suspended">
      <h2>
        {users.length} compte{users.length > 1 ? 's' : ''} sous le coup d’une mesure
      </h2>

      <ul>
        {users.map((user) => {
          const term = remaining(user.suspendedUntil);

          return (
            <li key={user.id}>
              <div className="head">
                <span className="who">{partyLabel(user)}</span>
                <span className={term.watch ? 'term watch' : 'term'}>{term.label}</span>
              </div>

              <p className="quote">{user.suspensionReason ?? '(sans motif)'}</p>

              <p className="muted">
                Depuis le {formatDate(user.suspendedAt)}
                {user.suspendedUntil !== null && `, jusqu’au ${formatDate(user.suspendedUntil)}`}
              </p>

              {confirming === user.id ? (
                <div className="confirm">
                  <span>Rendre l’accès à ce compte ?</span>
                  <button onClick={() => void lift(user)} disabled={busy === user.id}>
                    Oui, lever
                  </button>
                  <button className="link" onClick={() => setConfirming(null)}>
                    Annuler
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirming(user.id)}>Lever la suspension</button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
