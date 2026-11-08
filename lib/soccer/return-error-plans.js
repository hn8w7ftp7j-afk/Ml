import { soccerForwardHash } from './forward-validation.js';

// Server-owned, explicitly chosen future research calendars. These are not
// accepted football models or a source of formal R/S authority.
export const SOCCER_RETURN_ERROR_CALENDAR_VERSION = 'SOCCER-RETURN-ERROR-PROSPECTIVE-CALENDAR-v1';
const templateHash = '9c7e4b7fab15c5714aa22c6a6c508c1a631388c8585ebe247def5b8a57fa97e4';
const plans = Object.freeze({
  epl: Object.freeze({ league: 'epl', from: '2026-11-09', trainingBefore: '2026-11-25T00:00:00.000Z',
    calibrationBefore: '2026-12-08T00:00:00.000Z', testBefore: '2026-12-23T00:00:00.000Z', miscoverage: 0.1 }),
  ucl: Object.freeze({ league: 'ucl', from: '2026-11-09', trainingBefore: '2026-11-30T00:00:00.000Z',
    calibrationBefore: '2027-01-23T00:00:00.000Z', testBefore: '2027-01-30T00:00:00.000Z', miscoverage: 0.1 }),
});
export function soccerReturnErrorPlannedProtocol(league) {
  if (!Object.hasOwn(plans, league)) throw Error('RETURN_ERROR_BOOTSTRAP_LEAGUE_INVALID');
  const body = { version: SOCCER_RETURN_ERROR_CALENDAR_VERSION, protocolTemplateHash: templateHash,
    plan: plans[league], evidenceRef: 'research/soccer/return-error/prospective-calendar-v1.md' };
  return { ...structuredClone(body), manifestHash: soccerForwardHash(body) };
}
