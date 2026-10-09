import type { Team } from '../../contracts';

export interface TeamCatalog {
  listTeams(): Promise<Team[]>;
}
