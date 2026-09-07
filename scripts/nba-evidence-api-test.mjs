import assert from 'node:assert/strict';
import { GET as official } from '../app/api/nba/official/route.js';
import { GET as snapshots, POST as capture } from '../app/api/nba/pregame/route.js';
import { createSessionToken } from '../lib/security.js';
process.env.APP_PASSWORD = 'synthetic-nba-only-test'; process.env.SESSION_SECRET = 'synthetic-nba-only-test-secret';
const cookie = `mlb_session=${await createSessionToken()}`;
let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('No source calls allowed'); };
const req = (query, authenticated = true, method = 'GET', origin = 'http://localhost') => new Request(`http://localhost/api/nba/official?${query}`, { method, headers: { ...(authenticated ? { cookie } : {}), origin } });
for (const route of [official, snapshots]) { assert.equal((await route(req('id=123', false))).status, 401); for (const query of ['id=nhl:123', 'id=123&league=NHL', 'id=0', 'id=']) assert.equal((await route(req(query))).status, 400); }
assert.equal((await capture(req('id=123', true, 'POST', 'https://other.example'))).status, 403);
assert.equal((await capture(req('id=123', false, 'POST'))).status, 401);
assert.equal(calls, 0); console.log('NBA evidence APIs: auth, CSRF, IDs and league isolation passed without source or DB requests');
