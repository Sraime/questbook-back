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
