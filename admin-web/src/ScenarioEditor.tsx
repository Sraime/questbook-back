import { useState } from 'react';
import { api } from './api';
import { formatDate } from './format';
import type { ScenarioDetail } from './types';

interface ScenarioEditorProps {
  /// `null` pour une aventure qui n'existe pas encore.
  scenario: ScenarioDetail | null;
  onSaved: (scenario: ScenarioDetail) => void;
  onDirtyChange: (dirty: boolean) => void;
  onError: (cause: unknown) => void;
}

/// Une ligne de PNJ ou d'indice en cours d'edition.
///
/// `key` n'est pas `id` : un element qu'on vient d'ajouter n'a pas encore
/// d'identifiant, et se servir de son indice ferait perdre le curseur des
/// qu'on deplace une ligne. `id` reste absent jusqu'a l'enregistrement, et
/// c'est ce qui dit au serveur qu'il s'agit d'une creation.
interface Row {
  key: string;
  id?: string;
}

interface NpcRow extends Row {
  name: string;
  description: string;
}

interface ClueRow extends Row {
  title: string;
  contentMarkdown: string;
  sharedWith: number;
}

interface Draft {
  title: string;
  description: string;
  context: string;
  rundownMarkdown: string;
  minRecommendedPlayers: number;
  maxRecommendedPlayers: number;
  averageDurationMinutes: number;
  grantOnSignup: boolean;
  npcs: NpcRow[];
  clues: ClueRow[];
}

const newKey = () => Math.random().toString(36).slice(2);

const blank = (): Draft => ({
  title: '',
  description: '',
  context: '',
  rundownMarkdown: '',
  minRecommendedPlayers: 3,
  maxRecommendedPlayers: 5,
  averageDurationMinutes: 180,
  grantOnSignup: false,
  npcs: [],
  clues: [],
});

const from = (scenario: ScenarioDetail): Draft => ({
  title: scenario.title,
  description: scenario.description,
  context: scenario.context,
  rundownMarkdown: scenario.rundownMarkdown,
  minRecommendedPlayers: scenario.minRecommendedPlayers,
  maxRecommendedPlayers: scenario.maxRecommendedPlayers,
  averageDurationMinutes: scenario.averageDurationMinutes,
  grantOnSignup: scenario.grantOnSignup,
  npcs: scenario.npcs.map((npc) => ({ key: newKey(), ...npc })),
  clues: scenario.clues.map((clue) => ({ key: newKey(), ...clue })),
});

/// Ce qui manque pour que le serveur accepte, dit avant de l'envoyer.
function missing(draft: Draft): string | null {
  if (draft.title.trim().length === 0) return 'Il faut un titre.';
  if (draft.description.trim().length === 0) return 'Il faut un résumé.';
  if (draft.context.trim().length === 0) return 'Il faut un contexte.';
  if (draft.rundownMarkdown.trim().length === 0) return 'Il faut un déroulé.';
  if (draft.maxRecommendedPlayers < draft.minRecommendedPlayers) {
    return 'Le maximum de joueurs est sous le minimum.';
  }
  if (draft.npcs.some((npc) => npc.name.trim().length === 0)) {
    return 'Un personnage est sans nom.';
  }
  if (draft.clues.some((clue) => clue.title.trim().length === 0)) {
    return 'Un indice est sans titre.';
  }
  if (draft.clues.some((clue) => clue.contentMarkdown.trim().length === 0)) {
    return 'Un indice est vide : c’est ce qu’on remet au joueur.';
  }
  return null;
}

/// Ecrire une aventure du catalogue.
///
/// Le meme formulaire sert a en creer une et a en corriger une : les champs
/// sont les memes, et deux ecrans presque identiques finiraient par diverger.
export function ScenarioEditor({
  scenario,
  onSaved,
  onDirtyChange,
  onError,
}: ScenarioEditorProps) {
  const [draft, setDraft] = useState<Draft>(() =>
    scenario === null ? blank() : from(scenario),
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const change = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
    onDirtyChange(true);
  };

  const incomplete = missing(draft);

  const save = async () => {
    if (incomplete !== null) return;
    setBusy(true);
    try {
      const body = {
        title: draft.title.trim(),
        description: draft.description.trim(),
        context: draft.context,
        rundownMarkdown: draft.rundownMarkdown,
        minRecommendedPlayers: draft.minRecommendedPlayers,
        maxRecommendedPlayers: draft.maxRecommendedPlayers,
        averageDurationMinutes: draft.averageDurationMinutes,
        grantOnSignup: draft.grantOnSignup,
        npcs: draft.npcs.map((npc) => ({
          id: npc.id,
          name: npc.name.trim(),
          description: npc.description,
        })),
        clues: draft.clues.map((clue) => ({
          id: clue.id,
          title: clue.title.trim(),
          contentMarkdown: clue.contentMarkdown,
        })),
      };

      const updated =
        scenario === null
          ? await api<ScenarioDetail>('/admin/scenarios', { method: 'POST', body })
          : await api<ScenarioDetail>(`/admin/scenarios/${scenario.id}`, {
              method: 'PATCH',
              body,
            });

      // Relire la reponse plutot que garder le brouillon : les personnages et
      // les indices qu'on vient d'ajouter n'avaient pas d'identifiant, et un
      // second enregistrement les creerait une seconde fois.
      setDraft(from(updated));
      onDirtyChange(false);
      setSaved(true);
      onSaved(updated);
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  };

  const moveNpc = (index: number, by: number) =>
    change({ npcs: moved(draft.npcs, index, by) });
  const moveClue = (index: number, by: number) =>
    change({ clues: moved(draft.clues, index, by) });

  return (
    <section className="detail scenario">
      <header>
        <h2>{scenario === null ? 'Nouveau scénario' : draft.title}</h2>
        {scenario !== null && (
          <p className="muted">
            Modifié le {formatDate(scenario.updatedAt)} — {scenario.owners} compte
            {scenario.owners > 1 ? 's' : ''} le possède{scenario.owners > 1 ? 'nt' : ''},{' '}
            {scenario.sessions} séance{scenario.sessions > 1 ? 's' : ''} le joue
            {scenario.sessions > 1 ? 'nt' : ''}.
          </p>
        )}
      </header>

      {scenario !== null && scenario.owners > 0 && (
        <div className="block warn">
          <h3>Ce qui est déjà téléchargé ne bougera pas</h3>
          <p className="muted">
            L’application garde l’aventure telle qu’elle l’a reçue. Une correction
            d’aujourd’hui ne parviendra qu’aux comptes qui téléchargeront le scénario après
            elle — une séance en cours ne verra pas son déroulé changer sous les yeux du
            meneur.
          </p>
        </div>
      )}

      <div className="block">
        <h3>L’aventure</h3>

        <label className="note">
          Titre
          <input
            value={draft.title}
            onChange={(event) => change({ title: event.target.value })}
            maxLength={160}
          />
        </label>

        <label className="note">
          Résumé — la phrase que la boutique montre
          <textarea
            value={draft.description}
            onChange={(event) => change({ description: event.target.value })}
            rows={2}
            maxLength={600}
          />
        </label>

        <div className="numbers">
          <label className="note">
            Joueurs, au moins
            <input
              type="number"
              min={1}
              max={12}
              value={draft.minRecommendedPlayers}
              onChange={(event) =>
                change({ minRecommendedPlayers: Number(event.target.value) })
              }
            />
          </label>
          <label className="note">
            Joueurs, au plus
            <input
              type="number"
              min={1}
              max={12}
              value={draft.maxRecommendedPlayers}
              onChange={(event) =>
                change({ maxRecommendedPlayers: Number(event.target.value) })
              }
            />
          </label>
          <label className="note">
            Durée, en minutes
            <input
              type="number"
              min={15}
              max={1440}
              step={15}
              value={draft.averageDurationMinutes}
              onChange={(event) =>
                change({ averageDurationMinutes: Number(event.target.value) })
              }
            />
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.grantOnSignup}
            onChange={(event) => change({ grantOnSignup: event.target.checked })}
          />
          <span>
            <strong>Offerte à tout le monde</strong>
            <em>
              Chaque compte la reçoit à sa prochaine connexion, sans passer par la boutique.
            </em>
          </span>
        </label>
      </div>

      <div className="block">
        <h3>Contexte</h3>
        <p className="muted">Ce que le meneur lit avant la partie. Markdown.</p>
        <textarea
          className="prose"
          value={draft.context}
          onChange={(event) => change({ context: event.target.value })}
          rows={8}
          maxLength={20_000}
        />
      </div>

      <div className="block">
        <h3>Déroulé</h3>
        <p className="muted">
          Markdown. Les titres de niveau deux (<code>##</code>) deviennent le sommaire de
          l’aventure dans l’application.
        </p>
        <textarea
          className="prose tall"
          value={draft.rundownMarkdown}
          onChange={(event) => change({ rundownMarkdown: event.target.value })}
          rows={20}
          maxLength={200_000}
        />
      </div>

      <div className="block">
        <h3>Personnages non joueurs</h3>
        <p className="muted">
          Le meneur les retrouve dans sa séance. Un joueur ne les voit jamais.
        </p>

        {draft.npcs.map((npc, index) => (
          <div className="row-editor" key={npc.key}>
            <div className="row-head">
              <input
                value={npc.name}
                onChange={(event) =>
                  change({ npcs: patched(draft.npcs, index, { name: event.target.value }) })
                }
                placeholder="Nom"
                maxLength={120}
              />
              <button
                className="link"
                onClick={() => moveNpc(index, -1)}
                disabled={index === 0}
                title="Monter"
              >
                ↑
              </button>
              <button
                className="link"
                onClick={() => moveNpc(index, 1)}
                disabled={index === draft.npcs.length - 1}
                title="Descendre"
              >
                ↓
              </button>
              <button
                className="link destructive"
                onClick={() => change({ npcs: without(draft.npcs, index) })}
              >
                Retirer
              </button>
            </div>
            <textarea
              value={npc.description}
              onChange={(event) =>
                change({
                  npcs: patched(draft.npcs, index, { description: event.target.value }),
                })
              }
              rows={3}
              maxLength={10_000}
              placeholder="Ce qu’il sait, ce qu’il cache."
            />
          </div>
        ))}

        <button
          onClick={() =>
            change({ npcs: [...draft.npcs, { key: newKey(), name: '', description: '' }] })
          }
          disabled={draft.npcs.length >= 60}
        >
          + Ajouter un personnage
        </button>
      </div>

      <div className="block">
        <h3>Indices</h3>
        <p className="muted">
          Ce que le meneur remet aux joueurs pendant la séance, un par un.
        </p>

        {draft.clues.map((clue, index) => (
          <div className="row-editor" key={clue.key}>
            <div className="row-head">
              <input
                value={clue.title}
                onChange={(event) =>
                  change({ clues: patched(draft.clues, index, { title: event.target.value }) })
                }
                placeholder="Titre"
                maxLength={160}
              />
              <button
                className="link"
                onClick={() => moveClue(index, -1)}
                disabled={index === 0}
                title="Monter"
              >
                ↑
              </button>
              <button
                className="link"
                onClick={() => moveClue(index, 1)}
                disabled={index === draft.clues.length - 1}
                title="Descendre"
              >
                ↓
              </button>
              <button
                className="link destructive"
                onClick={() => change({ clues: without(draft.clues, index) })}
              >
                Retirer
              </button>
            </div>
            <textarea
              value={clue.contentMarkdown}
              onChange={(event) =>
                change({
                  clues: patched(draft.clues, index, { contentMarkdown: event.target.value }),
                })
              }
              rows={4}
              maxLength={20_000}
              placeholder="Le télégramme, la page arrachée, la photo."
            />
            {/* Le retirer effacerait aussi ce qui en a ete distribue : autant le
                savoir avant d'avoir clique. */}
            {clue.sharedWith > 0 && (
              <p className="muted">
                Déjà remis à {clue.sharedWith} joueur{clue.sharedWith > 1 ? 's' : ''} — le
                retirer effacerait ces remises.
              </p>
            )}
          </div>
        ))}

        <button
          onClick={() =>
            change({
              clues: [
                ...draft.clues,
                { key: newKey(), title: '', contentMarkdown: '', sharedWith: 0 },
              ],
            })
          }
          disabled={draft.clues.length >= 60}
        >
          + Ajouter un indice
        </button>
      </div>

      <div className="save">
        <button onClick={() => void save()} disabled={busy || incomplete !== null}>
          {busy
            ? 'Enregistrement…'
            : scenario === null
              ? 'Créer le scénario'
              : 'Enregistrer les corrections'}
        </button>
        {incomplete !== null && <span className="error">{incomplete}</span>}
        {incomplete === null && saved && <span className="muted">Enregistré.</span>}
      </div>
    </section>
  );
}

function patched<T>(rows: T[], index: number, patch: Partial<T>): T[] {
  return rows.map((row, at) => (at === index ? { ...row, ...patch } : row));
}

function without<T>(rows: T[], index: number): T[] {
  return rows.filter((_, at) => at !== index);
}

function moved<T>(rows: T[], index: number, by: number): T[] {
  const target = index + by;
  if (target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  next.splice(target, 0, ...next.splice(index, 1));
  return next;
}
