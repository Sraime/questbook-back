import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { AssetEditor, AssetPicture, kindLabels } from './AssetEditor';
import type { AdminAsset } from './types';

interface AssetCatalogueProps {
  onError: (cause: unknown) => void;
}

/// Les pions de la boutique.
///
/// Ajouter un pion demandait jusqu'ici une release de l'app : une image dans
/// le binaire, une entree dans deux tables du code, une migration. Ceux
/// ajoutes ici arrivent chez les joueurs sans rien de tout cela.
export function AssetCatalogue({ onError }: AssetCatalogueProps) {
  const [assets, setAssets] = useState<AdminAsset[] | null>(null);
  const [selected, setSelected] = useState<AdminAsset | null>(null);
  const [writing, setWriting] = useState(false);
  const dirty = useRef(false);

  const load = useCallback(async () => {
    try {
      setAssets(await api<AdminAsset[]>('/admin/assets'));
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

  const open = (asset: AdminAsset) => {
    if (asset.itemId === selected?.itemId || !leaving()) return;
    dirty.current = false;
    setWriting(false);
    setSelected(asset);
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
            + Nouvel asset
          </button>
        </div>

        {assets === null && <p className="muted padded">Chargement…</p>}
        {assets?.length === 0 && <p className="muted padded">Aucun asset en boutique.</p>}

        <ul>
          {assets?.map((asset) => (
            <li key={asset.itemId}>
              <button
                className={asset.itemId === selected?.itemId ? 'selected asset-row' : 'asset-row'}
                onClick={() => open(asset)}
              >
                <AssetPicture asset={asset} size={40} onError={onError} />
                <span>
                  <span className="row">
                    <strong>{asset.title}</strong>
                    {!asset.available && <span className="kind">retiré</span>}
                  </span>
                  <span className="muted small">
                    {asset.kind === null ? 'Embarqué dans l’app' : kindLabels[asset.kind]} ·{' '}
                    {asset.owners} possesseur{asset.owners > 1 ? 's' : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {selected === null && !writing ? (
        <section className="detail empty">
          <p className="muted">Choisis un asset, ou ajoutes-en un.</p>
        </section>
      ) : (
        <AssetEditor
          key={selected?.itemId ?? 'nouveau'}
          asset={selected}
          onDirtyChange={(value) => {
            dirty.current = value;
          }}
          onSaved={(asset) => {
            setWriting(false);
            setSelected(asset);
            void load();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}
