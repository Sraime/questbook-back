import { useEffect, useState } from 'react';
import { api, imageUrl } from './api';
import { formatDate } from './format';
import type { AdminAsset, AssetKind } from './types';

/// Les mots du lexique, et ceux du tiroir du meneur dans l'app.
export const kindLabels: Record<AssetKind, string> = {
  character: 'Personnage',
  environment: 'Environnement',
  effect: 'Effet',
  map: 'Carte',
};

interface AssetEditorProps {
  /// `null` pour un asset qui n'existe pas encore.
  asset: AdminAsset | null;
  onSaved: (asset: AdminAsset) => void;
  onDirtyChange: (dirty: boolean) => void;
  onError: (cause: unknown) => void;
}

/// Les memes limites que l'API, dites avant l'envoi plutot qu'apprises apres.
const maxMegabytes = (kind: AssetKind) => (kind === 'map' ? 5 : 2);
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

interface Draft {
  name: string;
  description: string;
  kind: AssetKind;
  available: boolean;
  /// L'image choisie, en base64, tant qu'elle n'est pas enregistree.
  image: string | null;
  imageBytes: number;
  preview: string | null;
}

const from = (asset: AdminAsset | null): Draft => ({
  name: asset?.title ?? '',
  description: asset?.description ?? '',
  kind: asset?.kind ?? 'character',
  available: asset?.available ?? false,
  image: null,
  imageBytes: 0,
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
  const isMap = draft.kind === 'map';
  // L'API refuse qu'une carte devienne un pion ou l'inverse : une fois cree,
  // on ne choisit plus que parmi les natures de sa famille.
  const kinds = (Object.keys(kindLabels) as AssetKind[]).filter(
    (kind) => asset === null || (kind === 'map') === (asset.kind === 'map'),
  );

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
    // La nature peut encore changer apres le choix du fichier : la limite se
    // verifie aussi a l'enregistrement, ici on n'ecarte que l'impossible.
    if (file.size > maxMegabytes('map') * 1024 * 1024) {
      setFileError(`L’image dépasse ${maxMegabytes('map')} Mo.`);
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

  const incomplete =
    draft.name.trim().length === 0
      ? 'Il faut un nom.'
      : asset === null && draft.image === null
        ? 'Il faut une image.'
        : draft.imageBytes > maxMegabytes(draft.kind) * 1024 * 1024
          ? `L’image d’un pion ne dépasse pas ${maxMegabytes(draft.kind)} Mo.`
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
        <h3>{isMap ? 'La carte' : 'Le pion'}</h3>

        <div className="asset-image">
          {draft.preview !== null ? (
            <img
              className={isMap ? 'map' : undefined}
              src={draft.preview}
              alt=""
              width={isMap ? 160 : 96}
              height={isMap ? undefined : 96}
            />
          ) : asset !== null ? (
            <AssetPicture asset={asset} size={isMap ? 160 : 96} onError={onError} />
          ) : (
            <span className="asset-empty" />
          )}

          {editable ? (
            <label className="note">
              {asset === null ? 'Image' : 'Remplacer l’image'} — PNG, JPEG ou WebP,{' '}
              {maxMegabytes(draft.kind)} Mo au plus.{' '}
              {isMap
                ? 'Elle couvre tout le plateau, qui en prend les proportions.'
                : 'Elle s’affiche dans un cercle : un sujet centré sur fond transparent rend le mieux.'}
              {asset !== null && asset.width !== null && asset.height !== null && (
                <> Actuelle : {asset.width} × {asset.height} px.</>
              )}
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
          Nom — celui du tiroir du meneur et de l’article en boutique
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
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabels[kind]}
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

  // Une carte se montre en rectangle, aux proportions du plateau.
  const map = asset.kind === 'map';
  const height = map ? Math.round((size * 3) / 4) : size;
  const className = map ? 'map' : '';

  if (src === null) {
    return <span className={`asset-empty ${className}`} style={{ width: size, height }} />;
  }
  return (
    <img className={`asset-thumb ${className}`} src={src} alt="" width={size} height={height} />
  );
}
