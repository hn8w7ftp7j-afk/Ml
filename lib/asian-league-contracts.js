import { CPBL_ASIAN_CONTRACT } from './asian-cpbl-contract.js';
import { KBO_ASIAN_CONTRACT } from './asian-kbo-contract.js';
import { NPB_ASIAN_CONTRACT } from './asian-npb-contract.js';

export const ASIAN_LEAGUE_CONTRACTS = Object.freeze({
  NPB: NPB_ASIAN_CONTRACT,
  KBO: KBO_ASIAN_CONTRACT,
  CPBL: CPBL_ASIAN_CONTRACT,
});

export function asianLeagueFeatureContract(leagueId) {
  return ASIAN_LEAGUE_CONTRACTS[String(leagueId || '').trim().toUpperCase()] || null;
}
