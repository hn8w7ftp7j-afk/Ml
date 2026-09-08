import { gunzipSync } from 'node:zlib';

// These mappings describe consumed CPBL response sections, not proof of model efficacy.
export function cpblFeatureBindings({ featureName, game, parsedInput, events, contents }) {
  const side = featureName.split('.')[0];
  const category = featureName.split('.')[1];
  const teamCode = { CTB: 'ACN011', UNI: 'ADD011', RKM: 'AJL011', FUB: 'AEO011', WCD: 'AAA011', TSG: 'AKP011' }[game[`${side}Code`]];
  const bindings = [];
  for (const event of events || []) {
    const content = contents?.[event.contentHash];
    if (!event.success || !content) continue;
    let body;
    try { body = JSON.parse(gunzipSync(Buffer.from(content.data, 'base64'), { maxOutputLength: 16 * 1024 * 1024 }).toString()); } catch { continue; }
    const add = (path, transformation) => bindings.push({ eventId: event.id, path, transformation });
    const rootPath = body?.Data?.Game ? ['Data', 'Game'] : body?.data?.game ? ['data', 'game'] : body?.Data ? ['Data'] : ['data'];
    const root = rootPath.reduce((v, key) => v?.[key], body);
    if (event.url?.includes('/games/')) {
      for (const key of ['Visiting', 'Home']) {
        const block = root?.[key];
        if (!teamCode || block?.Team?.Code !== teamCode) continue;
        if (category === 'lineup' && String(parsedInput?.asOfGamePk || '') && !event.url.endsWith(String(parsedInput.asOfProviderGameId || 'NO_MATCH'))) continue;
        const field = category === 'lineup' ? 'Hitters' : 'Pitchers';
        if (category && Array.isArray(block?.[field])) add([...rootPath, key, field], category === 'starter' ? 'FILTER_TEAM_AND_STARTER_PLAYER_ID;RECENT_START_INNINGS_MEAN;ROTATION_ASSIGNMENT' : category === 'bullpen' ? 'FILTER_ROLE_NOT_STARTER;SUM_IP_AND_ER;ERA_RATIO_LOG_SHRINK' : 'FIRST_NINE_STARTING_SLOTS;HISTORICAL_LINEUP_PROJECTION');
      }
      if (featureName === 'park' && root?.Field) add([...rootPath, 'Field'], 'RECOGNIZE_VENUE;JOIN_HISTORY_RUN_SAMPLE');
    }
    if (category === 'starter' && event.url?.includes('/leaderboards/pr-table?searchType=pitcher')) {
      for (const path of [['Data','Leaderboard'],['Data','Rows'],['Data','Table'],['Data']]) {
        if (Array.isArray(path.reduce((v,k)=>v?.[k],body))) { add(path, 'PLAYER_ACNT_MATCH;PA_WEIGHTED_LEAGUE_WOBA;WOBA_RATIO_SAMPLE_SHRINK'); break; }
      }
    }
    if (category === 'starter' && body?.Data?.Player?.Basic?.Acnt === parsedInput?.id) add(['Data','Player','Basic'], 'PLAYER_ACNT_AND_TEAM_CODE_IDENTITY;THROWS');
    if (category === 'starter' && Array.isArray(body?.Data?.Players)) add(['Data','Players'], 'MATCH_NAME_TEAM_CODE_AND_PITCHER_POSITION');
  }
  return bindings;
}

export function inspectFeatureMapping(row, rawForEvent) {
  if (!row?.sourceBindings?.length) return { status: 'PENDING', reasons: ['FEATURE_MAPPING_NOT_RECORDED'] };
  const reasons = [];
  for (const binding of row.sourceBindings) {
    let body;
    try { body = JSON.parse(rawForEvent(binding.eventId)); } catch { reasons.push('MAPPING_SOURCE_UNAVAILABLE'); continue; }
    if (!Array.isArray(binding.path) || !binding.path.length || !binding.transformation) { reasons.push('MAPPING_RULE_OR_PATH_MISSING'); continue; }
    if (binding.path.reduce((value, key) => value?.[key], body) === undefined) reasons.push('MAPPED_PATH_NOT_FOUND');
  }
  return { status: reasons.length ? 'PENDING' : 'MAPPED_PATHS_PRESENT', reasons: [...new Set(reasons)], scope: 'SOURCE_SECTION_PATHS_AND_DECLARED_TRANSFORMATIONS;NOT_DERIVATION_REPLAY' };
}
