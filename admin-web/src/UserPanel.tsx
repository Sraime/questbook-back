import { useEffect, useState } from 'react';
import { api } from './api';
import { formatDate } from './format';
import type { UserDetail } from './types';

interface UserPanelProps {
  userId: string;
  onError: (message: string) => void;
}

/// Les durees proposees, plutot qu'un champ de date.
///
/// Choisir une echeance au calendrier invite a bricoler une duree ; trois
/// paliers et « indefiniment » couvrent ce que la moderation fait vraiment, et
/// rendent la decision comparable d'un dossier a l'autre.
const durations: Array<{ label: string; days: number | null }> = [
  { label: '24 heures', days: 1 },
  { label: '7 jours', days: 7 },
  { label: '30 jours', days: 30 },
  { label: 'Indéfiniment', days: null },
];

export function UserPanel({ userId, onError }: UserPanelProps) {
  const [user, setUser] = useState<UserDetail | null>(null);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState<number | null>(7);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setUser(null);
    setClosing(false);
    setConfirmEmail('');

    api<UserDetail>(`/admin/users/${userId}`)
      .then((loaded) => {
        if (current) setUser(loaded);
      })
      .catch((cause: unknown) => {
        onError(cause instanceof Error ? cause.message : 'Compte illisible.');
      });

    return () => {
      current = false;
    };
  }, [userId, onError]);

  if (user === null) {
    return (
      <div className="block">
        <h3>Le compte visé</h3>
        <p className="muted">Chargement…</p>
      </div>
    );
  }

  const act = async (run: () => Promise<UserDetail | void>) => {
    setBusy(true);
    try {
      const updated = await run();
      if (updated) setUser(updated);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Action impossible.');
    } finally {
      setBusy(false);
    }
  };

  const suspend = () =>
    act(() =>
      api<UserDetail>(`/admin/users/${user.id}/suspend`, {
        method: 'POST',
        body: {
          reason: reason.trim(),
          ...(days === null
            ? {}
            : { until: new Date(Date.now() + days * 86_400_000).toISOString() }),
        },
      }),
    );

  const lift = () =>
    act(() => api<UserDetail>(`/admin/users/${user.id}/suspend`, { method: 'DELETE' }));

  const close = () =>
    act(async () => {
      await api<void>(`/admin/users/${user.id}`, {
        method: 'DELETE',
        body: { confirmEmail },
      });
      window.location.reload();
    });

  return (
    <div className={user.suspended ? 'block sanction suspended' : 'block sanction'}>
      <h3>Le compte visé</h3>

      <dl className="facts">
        <div>
          <dt>Adresse</dt>
          <dd>{user.email}</dd>
        </div>
        <div>
          <dt>Pseudo</dt>
          <dd>{user.displayName ?? '(sans pseudo)'}</dd>
        </div>
        <div>
          <dt>Inscrit le</dt>
          <dd>{formatDate(user.createdAt)}</dd>
        </div>
        <div>
          <dt>Dossiers ouverts</dt>
          <dd>{user.openReports}</dd>
        </div>
      </dl>

      {user.suspended ? (
        <div className="state">
          <p>
            <strong>Suspendu</strong> depuis le {formatDate(user.suspendedAt)}
            {user.suspendedUntil === null
              ? ', indéfiniment.'
              : `, jusqu’au ${formatDate(user.suspendedUntil)}.`}
          </p>
          <p className="quote">{user.suspensionReason}</p>
          <button onClick={lift} disabled={busy}>
            Lever la suspension
          </button>
        </div>
      ) : (
        <div className="state">
          <label className="note">
            Motif, lu par le joueur
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Il le lira à sa prochaine ouverture de l’app."
            />
          </label>

          <div className="durations">
            {durations.map((duration) => (
              <button
                key={duration.label}
                className={days === duration.days ? 'chip on' : 'chip'}
                onClick={() => setDays(duration.days)}
              >
                {duration.label}
              </button>
            ))}
          </div>

          {/* Le motif est exige par l'API : une sanction sans motif est une
              sanction qu'on ne peut pas contester. Le bouton le dit avant. */}
          <button onClick={suspend} disabled={busy || reason.trim().length === 0}>
            Suspendre ce compte
          </button>
        </div>
      )}

      <details
        className="danger"
        open={closing}
        onToggle={(event) => setClosing(event.currentTarget.open)}
      >
        <summary>Fermer définitivement ce compte</summary>
        <p>
          Irréversible. Emporte {user.ownedTables} table
          {user.ownedTables > 1 ? 's' : ''} qu’il anime, {user.characters} personnage
          {user.characters > 1 ? 's' : ''}, et tout ce qui en dépend.
        </p>
        <p className="muted">
          Recopie <code>{user.email}</code> pour confirmer.
        </p>
        <input
          value={confirmEmail}
          onChange={(event) => setConfirmEmail(event.target.value)}
          placeholder={user.email}
          autoComplete="off"
        />
        <button
          className="destructive"
          onClick={close}
          disabled={busy || confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()}
        >
          Fermer ce compte
        </button>
      </details>
    </div>
  );
}
