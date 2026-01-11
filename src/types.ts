export type ScrapedMatch = {
  teamName: string; // ex: "MDR"
  opponentName: string;
  tournamentName: string;
  bestOf?: string; // ex: "BO3"
  startUtcIso: string; // ISO UTC, ex: 2026-01-10T12:00:00.000Z
  sourceUrl: string; // page match si disponible, sinon base
};

export type MatchPayload = {
  summary: string; // "MDR VS ADV"
  location: string; // "BOx — TOURNOI" ou "TOURNOI"
  description: string; // strictement 2 lignes
  // Heures de référence (officielles) du match.
  // Utilisées pour calculer les rappels même si on décale l'événement dans le calendrier.
  officialStartUtcIso?: string;
  officialEndUtcIso?: string;
  startUtcIso: string;
  endUtcIso: string;
  alarms: {
    minus1Hour: boolean;
    minus1Day: boolean;
  };
};

export type StateV1 = {
  version: 1;
  events: Record<
    string,
    {
      href: string;
      etag?: string;
      uid: string; // UID VEVENT (stable)
      matchId: string; // identifiant "métier" basé sur date/MDR/adversaire/tournoi
      payload: MatchPayload;
      lastSeenUtcIso: string;
    }
  >;
  matchIdIndex: Record<string, { eventKey: string; lastSeenUtcIso: string }>;
};


