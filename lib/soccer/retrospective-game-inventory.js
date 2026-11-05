import { validSoccerDate } from './contracts.js';
import { soccerJournalQuery } from './journal.js';
import { SOCCER_FORWARD_VERSION } from './forward-validation.js';

// A single read-only PostgreSQL statement lists a bounded set of raw forward
// receipt scopes. It is not a forecast validation or an official schedule list.
export async function listSoccerRetrospectiveGames(league,date) {
  if(!['epl','ucl'].includes(league)||!validSoccerDate(date))
    throw Object.assign(Error('SOCCER_RETROSPECTIVE_INVENTORY_SCOPE_INVALID'),{status:400});
  const pattern=`^soccer:${league}:[0-9]{1,16}$`;
  const rows=await soccerJournalQuery(`WITH selected AS MATERIALIZED (
    SELECT game_id,count(*)::text AS receipt_count FROM sports_soccer_forward_captures_v1
    WHERE league=$1 AND board_date=$2::date AND protocol_version=$3
      AND game_id ~ $4 AND isfinite(captured_at) AND captured_at<=statement_timestamp()
    GROUP BY game_id ORDER BY game_id COLLATE "C" LIMIT 101
  ), diagnostics AS (
    SELECT COALESCE(bool_or(game_id !~ $4),false) AS invalid_game_identity,
      COALESCE(bool_or(isfinite(captured_at) AND captured_at>statement_timestamp()),false) AS future_receipt,
      COALESCE(bool_or(NOT isfinite(captured_at)),false) AS invalid_receipt_time
    FROM sports_soccer_forward_captures_v1 WHERE league=$1 AND board_date=$2::date AND protocol_version=$3
  ) SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
    d.invalid_game_identity,d.future_receipt,d.invalid_receipt_time,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('gameId',game_id,'captureCount',receipt_count) ORDER BY game_id COLLATE "C") FROM selected),'[]'::jsonb) AS games
  FROM diagnostics d`,[league,date,SOCCER_FORWARD_VERSION,pattern]);
  const row=rows[0];
  if(rows.length!==1||!row||!Array.isArray(row.games)||row.games.length>101
    ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.observed_at))
    throw Error('SOCCER_RETROSPECTIVE_INVENTORY_UNAVAILABLE');
  const validId=new RegExp(pattern),seen=new Set(),games=[];
  for(const game of row.games){
    const count=Number(game?.captureCount);
    if(!validId.test(game?.gameId||'')||seen.has(game.gameId)||!Number.isSafeInteger(count)||count<1)
      throw Error('SOCCER_RETROSPECTIVE_INVENTORY_INVALID');
    seen.add(game.gameId);games.push({gameId:game.gameId,captureCount:count});
  }
  const reasonCodes=[...(games.length>100?['GAME_INVENTORY_ROW_BUDGET']:[]),
    ...(row.invalid_game_identity?['INVALID_FORECAST_GAME_IDENTITY']:[]),...(row.future_receipt?['FUTURE_FORECAST_RECEIPT']:[]),
    ...(row.invalid_receipt_time?['INVALID_FORECAST_RECEIPT_TIME']:[])];
  return {status:reasonCodes.length?'PARTIAL':'INVENTORY_AVAILABLE',league,date,observedAt:row.observed_at,
    games:games.slice(0,100),reasonCodes,listingScope:'SINGLE_STATEMENT_CURRENT_PROTOCOL_RECEIPTS_ONLY',
    captureCountMeaning:'RAW_RECEIPTS_NOT_VALIDATED_FORECASTS',overallDateCoverage:'PARTIAL',
    crossRequestConsistency:'NOT_VERIFIED',forecastValidity:'NOT_VERIFIED',officialGameIdentity:'NOT_VERIFIED',
    formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,OOS:false,W:null,R:null,S:null};
}
