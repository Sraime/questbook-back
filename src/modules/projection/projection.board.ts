import type { SessionBoardDto } from '../tables/board.service.js';

/// Un pion tel que l'ecran de projection le dessine : sa forme, sa place, son
/// illustration. Rien d'autre.
export interface PublicToken {
  id: string;
  kind: string;
  color: string;
  x: number;
  y: number;
  size: number;
  assetKey?: string;
}

export interface PublicBoardDto {
  tokens: PublicToken[];
  mapId: string | null;
  revision: number;
}

/// Le plateau du MJ, reduit a ce qu'une salle peut regarder.
///
/// Le serveur ne lit jamais les pions ailleurs, et c'est ici l'exception
/// voulue : le plateau est ecrit par l'app et peut porter n'importe quoi, a
/// commencer par le lien d'un pion vers son personnage — l'identifiant d'un
/// joueur, celui d'un PNJ que la table n'a pas encore rencontre. Une page
/// publique ne recoit que les champs qu'elle dessine, recopies un par un :
/// un champ ajoute demain par l'app n'y passera pas sans qu'on l'ait decide.
export function publicBoard(board: SessionBoardDto): PublicBoardDto {
  return {
    tokens: publicTokens(board.tokens),
    mapId: typeof board.mapId === 'string' ? board.mapId : null,
    revision: board.revision,
  };
}

function publicTokens(raw: string): PublicToken[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const tokens: PublicToken[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const token = entry as Record<string, unknown>;
    const { id, kind, color, x, y, size, assetKey } = token;
    if (typeof id !== 'string' || !isFiniteNumber(x) || !isFiniteNumber(y)) continue;

    tokens.push({
      id,
      kind: typeof kind === 'string' ? kind : 'character',
      color: typeof color === 'string' ? color : 'red',
      x,
      y,
      size: isFiniteNumber(size) ? size : 0.07,
      ...(typeof assetKey === 'string' ? { assetKey } : {}),
    });
  }
  return tokens;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
