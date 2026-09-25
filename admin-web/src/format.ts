const dateTime = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const formatDate = (iso: string | null): string =>
  iso === null ? '—' : dateTime.format(new Date(iso));

/// L'age d'un dossier, en clair.
///
/// Les conditions d'utilisation annoncent un examen sous vingt-quatre heures.
/// Une date ISO ne dit pas si on est en retard ; « il y a 31 h » le dit d'un
/// coup d'oeil, et c'est la seule chose qu'on veut savoir en parcourant la
/// file.
export function age(iso: string, now: Date = new Date()): { label: string; late: boolean } {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);

  if (minutes < 60) {
    return { label: `il y a ${Math.max(minutes, 0)} min`, late: false };
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return { label: `il y a ${hours} h`, late: hours >= 24 };
  }

  return { label: `il y a ${Math.floor(hours / 24)} j`, late: true };
}

const contentLabels: Record<string, string> = {
  user: 'Un joueur',
  table: 'Une table',
  session: 'Une séance',
  investigator: 'Un investigateur',
};

export const contentLabel = (contentType: string): string =>
  contentLabels[contentType] ?? contentType;

const resolutionLabels: Record<string, string> = {
  dismissed: 'Classé sans suite',
  warned: 'Averti',
  suspended: 'Compte suspendu',
  deleted: 'Compte fermé',
};

export const resolutionLabel = (resolution: string | null): string =>
  resolution === null ? '—' : (resolutionLabels[resolution] ?? resolution);

export const partyLabel = (party: { email: string; displayName: string | null }): string =>
  party.displayName === null ? party.email : `${party.displayName} · ${party.email}`;
