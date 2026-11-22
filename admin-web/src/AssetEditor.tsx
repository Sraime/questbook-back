import { useEffect, useState } from 'react';
import { api, imageUrl } from './api';
import { formatDate } from './format';
import type { AdminAsset, AssetKind } from './types';

/// Les mots du lexique, et ceux du tiroir du meneur dans l'app.
export const kindLabels: Record<AssetKind, string> = {
  character: 'Personnage',
  environment: 'Environnement',
  effect: 'Effet',
};

interface AssetEditorProps {
  /// `null` pour un asset qui n'existe pas encore.
  asset: AdminAsset | null;
  onSaved: (asset: AdminAsset) => void;
  onDirtyChange: (dirty: boolean) => void;
  onError: (cause: unknown) => void;
}

/// La meme limite que l'API, dite avant l'envoi plutot qu'apprise apres.
const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

interface Draft {
  name: string;
  description: string;
  kind: AssetKind;
  available: boolean;
  /// L'image choisie, en base64, tant qu'elle n'est pas enregistree.
  image: string | null;
  preview: string | null;
}

const from = (asset: AdminAsset | null): Draft => ({
  name: asset?.title ?? '',
  description: asset?.description ?? '',
  kind: asset?.kind ?? 'character',
  available: asset?.available ?? false,
  image: null,
  preview: null,
});

/// Ajouter un asset, ou corriger un asset existant.
///
/// Un asset embarque dans l'app n'a ici que son titre, sa description et sa
/// disponibilite : son dessin est dans le binaire, et rien de ce qu'on
/// enverrait ne le changerait.
export function AssetEditor({ asset, onSaved, onDirtyChange, onError }: AssetEditorProps) {
  const [draft, setDraft] = useState<Draft>(() => from(asset));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const editable = asset === null || asset.hosted;

  const change = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
    onDirtyChange(true);
  };

  const pick = (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setFileError('Un PNG, un JPEG ou un WebP.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setFileError('L’image dépasse 2 Mo.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      change({ image: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  const incomplete =
    draft.name.trim().length === 0
      ? 'Il faut un nom.'
      : asset === null && draft.image === null
        ? 'Il faut une image.'
        : null;

  const save = async () => {
    if (incomplete !== null) return;
    setBusy(true);
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        available: draft.available,
        ...(editable ? { kind: draft.kind } : {}),
        ...(draft.image !== null ? { image: draft.image } : {}),
      };

      const updated =
        asset === null
          ? await api<AdminAsset>('/admin/assets', { method: 'POST', body })
          : await api<AdminAsset>(`/admin/assets/${asset.itemId}`, { method: 'PATCH', body });

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
        <h2>{asset === null ? 'Nouvel asset' : draft.name}</h2>
        {asset !== null && (
          <p className="muted">
            Clé <code>{asset.key}</code> · modifié le {formatDate(asset.updatedAt)} ·{' '}
            {asset.owners} compte{asset.owners > 1 ? 's' : ''} le possède
            {asset.owners > 1 ? 'nt' : ''}.
          </p>
        )}
      </header>

      <div className="block">
        <h3>Le pion</h3>

        <div className="asset-image">
          {draft.preview !== null ? (
            <img src={draft.preview} alt="" width={96} height={96} />
          ) : asset !== null ? (
            <AssetPicture asset={asset} size={96} onError={onError} />
          ) : (
            <span className="asset-empty" />
          )}

          {editable ? (
            <label className="note">
              {asset === null ? 'Image' : 'Remplacer l’image'} — PNG, JPEG ou WebP, 2 Mo au
              plus. Elle s’affiche dans un cercle : un sujet centré sur fond transparent rend
              le mieux.
              <input
                type="file"
                accept={ACCEPTED.join(',')}
                onChange={(event) => pick(event.target.files?.[0])}
              />
              {fileError !== null && <span className="error">{fileError}</span>}
            </label>
          ) : (
            <p className="muted">
              Cet asset est embarqué dans l’application : son dessin et sa nature ne se
              changent qu’avec une nouvelle version de l’app.
            </p>
          )}
        </div>

        <label className="note">
          Nom — celui du pion dans le tiroir du meneur et de l’article en boutique
          <input
            value={draft.name}
            onChange={(event) => change({ name: event.target.value })}
            maxLength={80}
          />
        </label>

        {editable && (
          <label className="note">
            Nature — le rayon où le meneur le trouve
            <select
              value={draft.kind}
              onChange={(event) => change({ kind: event.target.value as AssetKind })}
            >
              {Object.entries(kindLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="note">
          Description — ce que la boutique en dit
          <textarea
            value={draft.description}
            onChange={(event) => change({ description: event.target.value })}
            rows={3}
            maxLength={600}
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
            <em>
              Décoché, il disparaît de la boutique. Ceux qui l’ont le gardent, et il reste
              dessiné sur les plateaux où il est posé.
            </em>
          </span>
        </label>
      </div>

      <div className="save">
        <button onClick={() => void save()} disabled={busy || incomplete !== null}>
          {busy ? 'Enregistrement…' : asset === null ? 'Ajouter l’asset' : 'Enregistrer'}
        </button>
        {incomplete !== null && <span className="error">{incomplete}</span>}
        {incomplete === null && saved && <span className="muted">Enregistré.</span>}
      </div>
    </section>
  );
}

interface AssetPictureProps {
  asset: AdminAsset;
  size: number;
  onError: (cause: unknown) => void;
}

/// L'image telle que le serveur la sert, ou rien pour un asset embarque.
export function AssetPicture({ asset, size, onError }: AssetPictureProps) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!asset.hosted) return;
    let url: string | null = null;
    let live = true;

    imageUrl(`/admin/assets/${asset.itemId}/image`)
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
    // Le hash change avec l'image : c'est lui qui dit quand la recharger.
  }, [asset.itemId, asset.hosted, asset.imageHash, onError]);

  if (src === null) {
    return <span className="asset-empty" style={{ width: size, height: size }} />;
  }
  return <img className="asset-thumb" src={src} alt="" width={size} height={size} />;
}
