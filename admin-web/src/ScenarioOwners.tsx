import { useCallback, useEffect, useState } from 'react';
import { api, SessionExpired } from './api';
import { formatDate } from './format';
import type { ScenarioOwners as Owners } from './types';

interface ScenarioOwnersProps {
  scenarioId: string;
  /// Une aventure offerte a tout le monde se redonne toute seule : reprendre
  /// un don n'y tient pas, et l'ecran doit le dire plutot que de laisser
  /// croire a une panne.
  grantOnSignup: boolean;
  onError: (cause: unknown) => void;
}

/// A qui appartient une aventure, et comment la donner a quelqu'un.
///
/// Le reste de la fiche est un brouillon qu'on enregistre d'un bloc ; ici,
/// chaque geste part immediatement. C'est voulu : donner une aventure n'est
/// pas une correction de texte, et personne ne devrait avoir a cliquer sur
/// « Enregistrer les corrections » pour qu'un cadeau parte.
export function ScenarioOwners({ scenarioId, grantOnSignup, onError }: ScenarioOwnersProps) {
  const [state, setState] = useState<Owners | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  /// Un courriel inconnu se corrige sur place : l'afficher dans le bandeau du
  /// haut eloignerait le message du champ qui l'a provoque.
  const [refused, setRefused] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api<Owners>(`/admin/scenarios/${scenarioId}/owners`));
    } catch (cause) {
      onError(cause);
    }
  }, [scenarioId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => Promise<Owners>): Promise<boolean> => {
    setBusy(true);
    setRefused(null);
    try {
      setState(await run());
      return true;
    } catch (cause) {
      // Une session expiree ne se corrige pas ici : elle renvoie a l'ecran de
      // connexion, et c'est l'application qui sait le faire.
      if (cause instanceof SessionExpired) {
        onError(cause);
        return false;
      }
      setRefused(cause instanceof Error ? cause.message : 'Action impossible.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const give = async () => {
    const wanted = email.trim();
    if (wanted.length === 0) return;

    const done = await act(() =>
      api<Owners>(`/admin/scenarios/${scenarioId}/owners`, {
        method: 'POST',
        body: { email: wanted },
      }),
    );

    if (done) setEmail('');
  };

  const takeBack = (userId: string) =>
    act(() =>
      api<Owners>(`/admin/scenarios/${scenarioId}/owners/${userId}`, { method: 'DELETE' }),
    );

  const hidden = state === null ? 0 : state.total - state.owners.length;

  return (
    <div className="block owners">
      <h3>Qui la possède</h3>
      <p className="muted">
        {state === null
          ? 'Chargement…'
          : state.total === 0
            ? 'Personne pour l’instant : l’aventure n’apparaît dans aucun catalogue.'
            : `${state.total} compte${state.total > 1 ? 's' : ''}.`}
      </p>

      {grantOnSignup && (
        <p className="muted">
          Elle est <strong>offerte à tout le monde</strong> : chaque compte la reçoit en
          ouvrant l’écran des scénarios. Reprendre un don ne tiendra pas — il sera redonné
          au passage suivant.
        </p>
      )}

      <div className="give">
        <input
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void give();
          }}
          placeholder="courriel du compte"
          maxLength={320}
          aria-label="Courriel du compte à qui donner l’aventure"
        />
        <button onClick={() => void give()} disabled={busy || email.trim().length === 0}>
          Donner
        </button>
      </div>

      {refused !== null && <p className="error">{refused}</p>}

      {state !== null && state.owners.length > 0 && (
        <ul>
          {state.owners.map((owner) => (
            <li key={owner.userId}>
              <span className="who">
                <strong>{owner.displayName ?? owner.email}</strong>
                {owner.displayName !== null && <em>{owner.email}</em>}
              </span>
              <span className="muted small">
                {owner.source === 'purchase' ? 'Achetée' : 'Donnée'} le{' '}
                {formatDate(owner.grantedAt)}
              </span>
              {owner.source === 'purchase' ? (
                // Rembourser est une autre histoire. Retirer la ligne ferait
                // disparaitre de son ecran une aventure qu'il a payee.
                <span className="muted small">Un achat ne se reprend pas ici</span>
              ) : (
                <button
                  className="link destructive"
                  onClick={() => void takeBack(owner.userId)}
                  disabled={busy}
                >
                  Reprendre
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <p className="muted small">
          Et {hidden} autre{hidden > 1 ? 's' : ''}, plus anciens.
        </p>
      )}

      {state !== null && state.total > 0 && (
        <p className="muted small">
          Reprendre ferme l’accès au catalogue, mais n’efface rien : une copie déjà
          téléchargée reste lisible hors ligne sur l’appareil.
        </p>
      )}
    </div>
  );
}
