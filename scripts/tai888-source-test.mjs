import assert from 'node:assert/strict';
import {
  discoverLoginFormForTest,
  extractVisibleTextForTest,
  tai888SourceStatus,
} from '../lib/tai888-source.js';
import { oddsApiWindow, strictIsoSeconds } from '../lib/reference-time.js';

const form = discoverLoginFormForTest(`
<html><body>
<form method="post" action="/member/login">
  <input type="hidden" name="csrf" value="abc123">
  <input type="text" name="account">
  <input type="password" name="passwd">
  <button type="submit" name="action" value="login">登入</button>
</form>
</body></html>
`, 'https://xg1.tai888.in/');
assert.ok(form);
assert.equal(form.action, 'https://xg1.tai888.in/member/login');
assert.equal(form.method, 'POST');
assert.equal(form.usernameField, 'account');
assert.equal(form.passwordField, 'passwd');
assert.equal(form.fields.csrf, 'abc123');
assert.equal(form.fields.action, 'login');

const visible = extractVisibleTextForTest(`
<table>
<tr><th>隊伍</th><th>全場讓分</th><th>全場大小</th></tr>
<tr><td>波士頓紅襪</td><td>受讓1+50 0.950</td><td>大9-20 0.940</td></tr>
<tr><td>多倫多藍鳥</td><td>讓1+50 0.950</td><td>小9-20 0.940</td></tr>
</table>
`);
assert.match(visible, /波士頓紅襪/);
assert.match(visible, /讓1\+50/);
assert.match(visible, /大9-20/);

assert.equal(tai888SourceStatus({}).configured, false);
assert.equal(tai888SourceStatus({
  TAI888_BASE_URL: 'https://xg1.tai888.in',
  TAI888_USERNAME: 'readonly',
  TAI888_PASSWORD: 'secret',
}).configured, true);
assert.equal(tai888SourceStatus({
  TAI888_BASE_URL: 'http://127.0.0.1',
  TAI888_USERNAME: 'readonly',
  TAI888_PASSWORD: 'secret',
}).configured, false);

assert.equal(strictIsoSeconds('2026-08-10T16:00:00.000Z'), '2026-08-10T16:00:00Z');
const windowFromDate = oddsApiWindow('2026-08-11', []);
assert.equal(windowFromDate.start, '2026-08-10T16:00:00Z');
assert.equal(windowFromDate.end, '2026-08-12T03:59:59Z');
assert.doesNotMatch(windowFromDate.start, /\.\d{3}Z$/);
assert.doesNotMatch(windowFromDate.end, /\.\d{3}Z$/);

const windowFromSchedule = oddsApiWindow('2026-08-11', [
  { gameDate: '2026-08-11T23:10:00Z' },
  { gameDate: '2026-08-12T02:10:00Z' },
]);
assert.equal(windowFromSchedule.start, '2026-08-11T21:10:00Z');
assert.equal(windowFromSchedule.end, '2026-08-12T10:10:00Z');

console.log(JSON.stringify({
  ok: true,
  loginAction: form.action,
  strictWindow: windowFromDate,
  scheduleWindow: windowFromSchedule,
}, null, 2));
