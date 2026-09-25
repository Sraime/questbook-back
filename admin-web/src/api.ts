/// Le jeton de session vit dans `sessionStorage`, et pas plus loin.
///
/// En memoire seulement aurait redemande le mot de passe et un code a chaque
/// rechargement de page, ce qui pousse a garder l'onglet ouvert — l'inverse de
/// ce qu'on veut. `localStorage` survivrait a la fermeture du navigateur, ce
/// qui est trop. Entre les deux, `sessionStorage` disparait avec l'onglet.
///
/// Le risque habituel de ce choix est le vol par script injecte. Il est ecarte
/// ici : aucune origine tierce ne parle a ce front, et React echappe tout ce
/// qu'il interpole — ce qui compte, cet ecran affichant par construction du
/// texte ecrit par quelqu'un qui cherchait a nuire.
const TOKEN_KEY = 'questbook.admin.token';

export const readToken = (): string | null => sessionStorage.getItem(TOKEN_KEY);
export const storeToken = (token: string): void => sessionStorage.setItem(TOKEN_KEY, token);
export const forgetToken = (): void => sessionStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/// Levee quand la session n'est plus valable. L'application la distingue des
/// autres pour renvoyer a l'ecran de connexion plutot que d'afficher une
/// erreur que rien ne permet de corriger.
export class SessionExpired extends ApiError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'Session expiree, reconnecte-toi.');
    this.name = 'SessionExpired';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /// La connexion est le seul appel qui n'a pas encore de jeton a presenter.
  anonymous?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = readToken();

  if (!options.anonymous && token === null) {
    throw new SessionExpired();
  }

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.anonymous || token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 401 && !options.anonymous) {
    forgetToken();
    throw new SessionExpired();
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? (payload as { error: { code?: string; message?: string } }).error
        : {};

    throw new ApiError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.message ?? `L'API a repondu ${response.status}.`,
    );
  }

  return payload as T;
}
