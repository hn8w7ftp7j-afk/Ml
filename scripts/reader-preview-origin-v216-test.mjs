import assert from 'node:assert/strict';
import { readerCorsHeaders, readerOriginAllowed } from '../lib/reader-auth-v2.js';

const original = {
  VERCEL_URL: process.env.VERCEL_URL,
  VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
};

function request(origin) {
  return new Request('https://example.test/api/reader/pair', {
    headers: origin == null ? {} : { Origin: origin },
  });
}

try {
  process.env.VERCEL_URL = 'mlb-ev-commit-123.vercel.app';
  process.env.VERCEL_BRANCH_URL = 'mlb-ev-git-agent-branch-team.vercel.app';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'mlb-positive-ev.vercel.app';

  assert.equal(readerOriginAllowed(request('https://mlb-positive-ev.vercel.app')), true);
  assert.equal(readerOriginAllowed(request('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')), true);
  assert.equal(readerOriginAllowed(request('https://mlb-ev-commit-123.vercel.app')), true);
  assert.equal(readerOriginAllowed(request('https://mlb-ev-git-agent-branch-team.vercel.app')), true);
  assert.equal(readerOriginAllowed(request('https://mlb-ev-commit-123.vercel.app.attacker.test')), false);
  assert.equal(readerOriginAllowed(request('http://mlb-ev-commit-123.vercel.app')), false);
  assert.equal(readerOriginAllowed(request('https://unrelated.vercel.app')), false);
  assert.equal(readerOriginAllowed(request(null)), true);

  const allowedCors = readerCorsHeaders(request('https://mlb-ev-commit-123.vercel.app'));
  assert.equal(allowedCors['Access-Control-Allow-Origin'], 'https://mlb-ev-commit-123.vercel.app');
  const deniedCors = readerCorsHeaders(request('https://unrelated.vercel.app'));
  assert.equal(deniedCors['Access-Control-Allow-Origin'], 'null');
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log('Reader Preview origin v2.1.16 tests passed.');
