export interface Admin {
  id: string;
  login: string;
  lastLoginAt: string | null;
}

export interface Party {
  id: string;
  email: string;
  displayName: string | null;
}

export type Resolution = 'dismissed' | 'warned' | 'suspended' | 'deleted';

export interface ReportSummary {
  id: string;
  status: 'open' | 'resolved';
  contentType: string;
  contentId: string;
  reason: string;
  createdAt: string;
  reportedUser: Party;
  resolution: Resolution | null;
  resolvedAt: string | null;
}

export interface ReportDetail extends ReportSummary {
  snapshot: Record<string, string>;
  reporter: Party;
  resolutionNote: string | null;
  resolvedBy: string | null;
  otherReportsOnSameUser: ReportSummary[];
}

export interface ReportPage {
  items: ReportSummary[];
  total: number;
}

/// Une mesure encore active. Le serveur exclut celles qui ont expire : une
/// suspension datee s'eteint d'elle-meme et le compte est deja revenu.
export interface SuspendedUser {
  id: string;
  email: string;
  displayName: string | null;
  suspendedAt: string;
  suspendedUntil: string | null;
  suspensionReason: string | null;
}

export interface ScenarioSummary {
  id: string;
  title: string;
  description: string;
  grantOnSignup: boolean;
  npcs: number;
  clues: number;
  owners: number;
  updatedAt: string;
}

export interface ScenarioNpc {
  id: string;
  name: string;
  description: string;
}

export interface ScenarioClue {
  id: string;
  title: string;
  contentMarkdown: string;
  /// Combien de joueurs l'ont deja recu. Retirer l'indice effacerait ces
  /// distributions, et l'ecran le dit avant qu'on le fasse.
  sharedWith: number;
}

export interface ScenarioDetail {
  id: string;
  title: string;
  description: string;
  context: string;
  rundownMarkdown: string;
  minRecommendedPlayers: number;
  maxRecommendedPlayers: number;
  averageDurationMinutes: number;
  grantOnSignup: boolean;
  createdAt: string;
  updatedAt: string;
  npcs: ScenarioNpc[];
  clues: ScenarioClue[];
  owners: number;
  sessions: number;
  shopItems: number;
}

export interface UserDetail {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  suspended: boolean;
  suspendedAt: string | null;
  suspendedUntil: string | null;
  suspensionReason: string | null;
  ownedTables: number;
  characters: number;
  openReports: number;
}
