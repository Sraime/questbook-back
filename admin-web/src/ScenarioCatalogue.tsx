import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ScenarioEditor } from './ScenarioEditor';
import { formatDate } from './format';
import type { ScenarioDetail, ScenarioSummary } from './types';

interface ScenarioCatalogueProps {
  onError: (cause: unknown) => void;
}

/// Ce qu'on ecrit ici n'est pas une donnee de compte : c'est le produit.
///
/// Le catalogue n'avait jusqu'ici aucun autre moyen d'exister qu'un `INSERT`
/// ecrit a la main dans une migration, relu par personne et deploye avec le
/// reste. Une aventure se compose maintenant a l'ecran, PNJ et indices
/// compris.
export function ScenarioCatalogue({ onError }: ScenarioCatalogueProps) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [selected, setSelected] = useState<ScenarioDetail | null>(null);
  const [writing, setWriting] = useState(false);
  /// Un deroule fait quinze pages : cliquer sur une autre ligne ne doit pas
  /// l'emporter en silence.
  const dirty = useRef(false);

  const load = useCallback(async () => {
    try {
      setScenarios(await api<ScenarioSummary[]>('/admin/scenarios'));
    } catch (cause) {
      onError(cause);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const leaving = () =>
    !dirty.current ||
    window.confirm('Des modifications ne sont pas enregistrées. Les abandonner ?');

  const open = async (id: string) => {
    if (id === selected?.id || !leaving()) return;
    try {
      const scenario = await api<ScenarioDetail>(`/admin/scenarios/${id}`);
      dirty.current = false;
      setWriting(false);
      setSelected(scenario);
    } catch (cause) {
      onError(cause);
    }
  };

  const compose = () => {
    if (!leaving()) return;
    dirty.current = false;
    setSelected(null);
    setWriting(true);
  };

  return (
    <div className="columns">
      <aside className="queue">
        <div className="queue-head">
          <button onClick={compose} className={writing ? 'selected' : ''}>
            + Nouveau scénario
          </button>
        </div>

        {scenarios === null && <p className="muted padded">Chargement…</p>}
        {scenarios?.length === 0 && <p className="muted padded">Le catalogue est vide.</p>}

        <ul>
          {scenarios?.map((scenario) => (
            <li key={scenario.id}>
              <button
                className={scenario.id === selected?.id ? 'selected' : ''}
                onClick={() => void open(scenario.id)}
              >
                <span className="row">
                  <strong>{scenario.title}</strong>
                  {scenario.grantOnSignup && <span className="kind">offerte</span>}
                </span>
                <span className="reason">{scenario.description}</span>
                <span className="muted small">
                  {scenario.npcs} PNJ · {scenario.clues} indice
                  {scenario.clues > 1 ? 's' : ''} · {scenario.owners} possesseur
                  {scenario.owners > 1 ? 's' : ''} · {formatDate(scenario.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {selected === null && !writing ? (
        <section className="detail empty">
          <p className="muted">Choisis une aventure, ou écris-en une.</p>
        </section>
      ) : (
        <ScenarioEditor
          key={selected?.id ?? 'nouveau'}
          scenario={selected}
          onDirtyChange={(value) => {
            dirty.current = value;
          }}
          onSaved={(scenario) => {
            setWriting(false);
            setSelected(scenario);
            void load();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}
