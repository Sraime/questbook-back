import { useEffect, useState } from 'react';
import { api, imageUrl } from './api';
import { kindLabels } from './AssetEditor';
import { Autocomplete, type Choice } from './Autocomplete';
import { formatDate } from './format';
import type { AdminAsset, AdminBundle, ScenarioSummary } from './types';

const MAX_MEGABYTES = 2;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

interface BundleEditorProps {
  /// `null` pour un bundle qui n'existe pas encore.
  bundle: AdminBundle | null;
  onSaved: (bundle: AdminBundle) => void;
  onDirtyChange: (dirty: boolean) => void;
  onError: (cause: unknown) => void;
}

interface Draft {
  title: string;
  description: string;
  /// En euros, tel qu'on l'ecrit : la conversion en centimes se fait a l'envoi.
  price: string;
  available: boolean;
  assetItemIds: string[];
  scenarioIds: string[];
  image: string | null;
  imageBytes: number;
  preview: string | null;
}

const from = (bundle: AdminBundle | null): Draft => ({
  title: bundle?.title ?? '',
  description: bundle?.description ?? '',
  price: ((bundle?.priceCents ?? 0) / 100).toFixed(2),
  available: bundle?.available ?? false,
  assetItemIds: bundle?.contents.filter((e) => e.kind === 'asset').map((e) => e.id) ?? [],
  scenarioIds: bundle?.contents.filter((e) => e.kind === 'scenario').map((e) => e.id) ?? [],
  image: null,
  imageBytes: 0,
  preview: null,
});

const toCents = (price: string): number | null => {
  const value = Number(price.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

/// Creer un bundle, ou corriger un bundle existant.
///
/// Le contenu se choisit parmi ce qui existe deja, en vente ou non : un pion
/// fait pour un scenario n'a souvent aucune raison de se vendre seul.
export function BundleEditor({ bundle, onSaved, onDirtyChange, onError }: BundleEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => from(bundle));
  const [assets, setAssets] = useState<AdminAsset[] | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    api<AdminAsset[]>('/admin/assets').then(setAssets).catch(onError);
    api<ScenarioSummary[]>('/admin/scenarios').then(setScenarios).catch(onError);
  }, [onError]);

  const change = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
    onDirtyChange(true);
  };

  // La nature prefixe l'identifiant : un scenario et un article vivent dans
  // deux tables, et l'ecran les melange dans une meme liste.
  const add = (key: string) => {
    const [kind, id] = key.split(':') as ['asset' | 'scenario', string];
    const list = kind === 'asset' ? 'assetItemIds' : 'scenarioIds';
    if (!draft[list].includes(id)) change({ [list]: [...draft[list], id] });
  };

  const remove = (key: string) => {
    const [kind, id] = key.split(':') as ['asset' | 'scenario', string];
    const list = kind === 'asset' ? 'assetItemIds' : 'scenarioIds';
    change({ [list]: draft[list].filter((each) => each !== id) });
  };

  const assetHint = (asset: AdminAsset) =>
    asset.kind === null ? 'Pion embarqué dans l’app' : kindLabels[asset.kind];

  // Ce qui est deja dans le bundle ne se propose plus.
  const choices: Choice[] = [
    ...(scenarios ?? [])
      .filter((scenario) => !draft.scenarioIds.includes(scenario.id))
      .map((scenario) => ({ id: `scenario:${scenario.id}`, label: scenario.title, hint: 'Scénario' })),
    ...(assets ?? [])
      .filter((asset) => !draft.assetItemIds.includes(asset.itemId))
      .map((asset) => ({ id: `asset:${asset.itemId}`, label: asset.title, hint: assetHint(asset) })),
  ];

  // Ce que le bundle contient, lu dans les catalogues charges ; a defaut, dans
  // ce que le serveur a renvoye, le temps que ceux-ci arrivent.
  const known = new Map(bundle?.contents.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
  const contents = [
    ...draft.scenarioIds.map((id) => {
      const scenario = scenarios?.find((each) => each.id === id);
      return {
        key: `scenario:${id}`,
        title: scenario?.title ?? known.get(`scenario:${id}`)?.title ?? '…',
        hint: 'Scénario',
        withdrawn: false,
      };
    }),
    ...draft.assetItemIds.map((id) => {
      const asset = assets?.find((each) => each.itemId === id);
      const saved = known.get(`asset:${id}`);
      return {
        key: `asset:${id}`,
        title: asset?.title ?? saved?.title ?? '…',
        hint: asset ? assetHint(asset) : 'Asset',
        withdrawn: asset ? !asset.available : saved ? !saved.available : false,
      };
    }),
  ];

  const pick = (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setFileError('Un PNG, un JPEG ou un WebP.');
      return;
    }
    if (file.size > MAX_MEGABYTES * 1024 * 1024) {
      setFileError(`L’image dépasse ${MAX_MEGABYTES} Mo.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      change({
        image: dataUrl.slice(dataUrl.indexOf(',') + 1),
        imageBytes: file.size,
        preview: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  };

  const cents = toCents(draft.price);
  const incomplete =
    draft.title.trim().length === 0
      ? 'Il faut un titre.'
      : bundle === null && draft.image === null
        ? 'Il faut une image.'
        : cents === null
          ? 'Le prix doit être un nombre positif.'
          : draft.assetItemIds.length + draft.scenarioIds.length === 0
            ? 'Un bundle contient au moins un asset ou un scénario.'
            : null;

  const save = async () => {
    if (incomplete !== null || cents === null) return;
    setBusy(true);
    try {
      const body = {
        title: draft.title.trim(),
        description: draft.description.trim(),
        priceCents: cents,
        available: draft.available,
        assetItemIds: draft.assetItemIds,
        scenarioIds: draft.scenarioIds,
        ...(draft.image !== null ? { image: draft.image } : {}),
      };

      const updated =
        bundle === null
          ? await api<AdminBundle>('/admin/bundles', { method: 'POST', body })
          : await api<AdminBundle>(`/admin/bundles/${bundle.itemId}`, { method: 'PATCH', body });

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

  return (
    <section className="detail">
      <header>
        <h2>{bundle === null ? 'Nouveau bundle' : draft.title}</h2>
        {bundle !== null && (
          <p className="muted">
            Modifié le {formatDate(bundle.updatedAt)} · {bundle.owners} compte
            {bundle.owners > 1 ? 's' : ''} le possède{bundle.owners > 1 ? 'nt' : ''}.
          </p>
        )}
      </header>

      <div className="block">
        <h3>L’article</h3>

        <div className="asset-image">
          {draft.preview !== null ? (
            <img src={draft.preview} alt="" width={96} height={96} />
          ) : bundle !== null ? (
            <BundlePicture bundle={bundle} size={96} onError={onError} />
          ) : (
            <span className="asset-empty" />
          )}

          <label className="note">
            {bundle === null ? 'Image' : 'Remplacer l’image'} — PNG, JPEG ou WebP,{' '}
            {MAX_MEGABYTES} Mo au plus. Elle illustre l’article en boutique.
            <input
              type="file"
              accept={ACCEPTED.join(',')}
              onChange={(event) => pick(event.target.files?.[0])}
            />
            {fileError !== null && <span className="error">{fileError}</span>}
          </label>
        </div>

        <label className="note">
          Titre
          <input
            value={draft.title}
            onChange={(event) => change({ title: event.target.value })}
            maxLength={80}
          />
        </label>

        <label className="note">
          Description — ce que la boutique en dit
          <textarea
            value={draft.description}
            onChange={(event) => change({ description: event.target.value })}
            rows={4}
            maxLength={2000}
          />
        </label>

        <label className="note">
          Prix, en euros — la boutique ne vend encore que ce qui est à 0
          <input
            value={draft.price}
            onChange={(event) => change({ price: event.target.value })}
            inputMode="decimal"
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.available}
            onChange={(event) => change({ available: event.target.checked })}
          />
          <span>
            <strong>En vente</strong>
            <em>Décoché, il disparaît de la boutique. Ceux qui l’ont gardent son contenu.</em>
          </span>
        </label>
      </div>

      <div className="block">
        <h3>Contenu</h3>
        <p className="muted small">
          Un scénario ou un asset, en vente ou non : ce qui ne se vend pas seul n’est alors
          obtenu que par le bundle.
        </p>
        <Autocomplete
          choices={choices}
          onPick={(choice) => add(choice.id)}
          placeholder={
            assets === null || scenarios === null
              ? 'Chargement…'
              : 'Chercher un scénario ou un asset…'
          }
          disabled={assets === null || scenarios === null}
        />

        {contents.length === 0 ? (
          <p className="muted small">Rien encore.</p>
        ) : (
          <ul className="picked">
            {contents.map((entry) => (
              <li key={entry.key}>
                <span>
                  <strong>{entry.title}</strong>
                  <br />
                  <em>
                    {entry.hint}
                    {entry.withdrawn ? ' · retiré de la vente' : ''}
                  </em>
                </span>
                <button className="link destructive" onClick={() => remove(entry.key)}>
                  Retirer
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="save">
        <button onClick={() => void save()} disabled={busy || incomplete !== null}>
          {busy ? 'Enregistrement…' : bundle === null ? 'Créer le bundle' : 'Enregistrer'}
        </button>
        {incomplete !== null && <span className="error">{incomplete}</span>}
        {incomplete === null && saved && <span className="muted">Enregistré.</span>}
      </div>
    </section>
  );
}

interface BundlePictureProps {
  bundle: AdminBundle;
  size: number;
  onError: (cause: unknown) => void;
}

export function BundlePicture({ bundle, size, onError }: BundlePictureProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (bundle.imageHash === null) return;
    let url: string | null = null;
    let live = true;

    imageUrl(`/admin/bundles/${bundle.itemId}/image`)
      .then((created) => {
        url = created;
        if (live) setSrc(created);
        else URL.revokeObjectURL(created);
      })
      .catch(onError);

    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [bundle.itemId, bundle.imageHash, onError]);

  if (src === null) {
    return <span className="asset-empty" style={{ width: size, height: size }} />;
  }
  return <img className="asset-thumb" src={src} alt="" width={size} height={size} />;
}
