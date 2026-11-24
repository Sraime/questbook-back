import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { BundleEditor, BundlePicture } from './BundleEditor';
import type { AdminBundle } from './types';

interface BundleCatalogueProps {
  onError: (cause: unknown) => void;
}

/// Les bundles de la boutique : de quoi preparer une partie d'un seul achat,
/// le scenario avec ses cartes et ses pions.
export function BundleCatalogue({ onError }: BundleCatalogueProps) {
  const [bundles, setBundles] = useState<AdminBundle[] | null>(null);
  const [selected, setSelected] = useState<AdminBundle | null>(null);
  const [writing, setWriting] = useState(false);
  const dirty = useRef(false);

  const load = useCallback(async () => {
    try {
      setBundles(await api<AdminBundle[]>('/admin/bundles'));
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

  const open = (bundle: AdminBundle) => {
    if (bundle.itemId === selected?.itemId || !leaving()) return;
    dirty.current = false;
    setWriting(false);
    setSelected(bundle);
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
            + Nouveau bundle
          </button>
        </div>

        {bundles === null && <p className="muted padded">Chargement…</p>}
        {bundles?.length === 0 && <p className="muted padded">Aucun bundle en boutique.</p>}

        <ul>
          {bundles?.map((bundle) => (
            <li key={bundle.itemId}>
              <button
                className={bundle.itemId === selected?.itemId ? 'selected asset-row' : 'asset-row'}
                onClick={() => open(bundle)}
              >
                <BundlePicture bundle={bundle} size={40} onError={onError} />
                <span>
                  <span className="row">
                    <strong>{bundle.title}</strong>
                    {!bundle.available && <span className="kind">retiré</span>}
                  </span>
                  <span className="muted small">
                    {bundle.contents.length} élément{bundle.contents.length > 1 ? 's' : ''} ·{' '}
                    {bundle.owners} possesseur{bundle.owners > 1 ? 's' : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {selected === null && !writing ? (
        <section className="detail empty">
          <p className="muted">Choisis un bundle, ou crées-en un.</p>
        </section>
      ) : (
        <BundleEditor
          key={selected?.itemId ?? 'nouveau'}
          bundle={selected}
          onDirtyChange={(value) => {
            dirty.current = value;
          }}
          onSaved={(bundle) => {
            setWriting(false);
            setSelected(bundle);
            void load();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}
