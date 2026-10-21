import {ESPN_NBA_TEAMS} from './identity.js';
import {researchScheduleOracle,validatedResearchScoreboard} from './opening-history-acquisition.js';

export const V6_HISTORICAL_TEAM_ALIAS_PROFILE='espn_historical_team_abbreviation_allowlist_2007_2011_v1';
// Exact raw provider IDs/names/years observed in the source archive. The raw
// bytes retain NJ/SEA; only a copied parser view uses the current ID's symbol.
// No unknown identity, event date or future-era alias can be repaired here.
export function adaptV6HistoricalTeams(body){
  const output=structuredClone(body);
  for(const event of output?.events||[]){
    const year=event.season?.year??body.requestedSeason?.year,date=Date.parse(event.date);
    for(const competitor of event.competitions?.[0]?.competitors||[]){
      const team=competitor.team,id=String(team?.id),expected=ESPN_NBA_TEAMS[id];
      if(team?.abbreviation===expected)continue;
      const validDate=Number.isInteger(year)&&Number.isFinite(date)&&date>=Date.UTC(year-1,6,1)&&date<Date.UTC(year,6,1);
      const nets=id==='17'&&team?.abbreviation==='NJ'&&team.displayName==='New Jersey Nets'&&year>=2007&&year<=2011;
      const seattle=id==='25'&&team?.abbreviation==='SEA'&&team.displayName==='Seattle SuperSonics'&&year>=2007&&year<=2008;
      if(!(validDate&&(nets||seattle)))throw Error('NBA_V6_HISTORICAL_TEAM_ALIAS_UNVERIFIED');
      team.abbreviation=expected;
    }
  }
  return output;
}
export function v6ResearchScheduleOracle(records,years){return researchScheduleOracle(records.map(r=>({...r,body:adaptV6HistoricalTeams(r.body)})),years);}
export function validatedV6ResearchScoreboard(body,expected,sourceHash){return validatedResearchScoreboard(adaptV6HistoricalTeams(body),expected,sourceHash);}
