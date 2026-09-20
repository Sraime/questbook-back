/// Les deux instants qui bornent la vie d'une séance.
///
/// Le calcul vit ici, et le DTO envoie le résultat : le client n'a pas à
/// reconstituer la règle, et deux implémentations ne peuvent pas diverger.

/// Une séance reste vivante pendant la partie, et bien après l'heure du
/// premier dé : on la consulte et on la corrige tant que la table est
/// assise, ce qui déborde toujours l'horaire annoncé.
export const sessionGraceMs = 24 * 60 * 60 * 1000;

/// Une séance proposée pour tout de suite — « on joue dans une demi-heure ? »
/// — n'aurait sans cela aucune fenêtre de réponse : elle serait close avant
/// que les joueurs n'aient vu la notification.
export const lateAnswerGraceMs = 60 * 60 * 1000;

/// Passé cet instant, la séance appartient au passé : elle n'est plus la
/// prochaine de sa table, et le mode MJ n'a plus rien à y animer.
export function sessionClosesAt(session: { startsAt: Date }): Date {
  return new Date(session.startsAt.getTime() + sessionGraceMs);
}

/// Passé cet instant, plus personne ne s'inscrit : le MJ a compté ses joueurs
/// et prépare sa table.
export function answersCloseAt(session: {
  startsAt: Date;
  createdAt: Date;
}): Date {
  const lateGrace = session.createdAt.getTime() + lateAnswerGraceMs;
  return new Date(Math.max(session.startsAt.getTime(), lateGrace));
}
