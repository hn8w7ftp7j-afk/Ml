import assert from 'node:assert/strict';
import '../reader/soccer-teams.js';

const teams = globalThis.Tai888SoccerTeams;
// Supplementary promoted-club aliases must agree with official English names,
// while preserving identities already emitted from the Chinese board labels.
for (const [expected, aliases] of [
  ['Coventry City', ['高雲地利', 'Coventry City', 'coventry city']],
  ['Hull City', ['侯城', '赫爾城', 'Hull City', 'HULL CITY']],
  ['Portsmouth', ['樸茨茅夫', 'Portsmouth', 'portsmouth']],
  ['布萊頓', ['白禮頓', '白礼顿', '白禮頓及賀夫', 'Brighton & Hove Albion']],
  ['兵工廠', ['阿仙奴', 'Arsenal']],
  ['切爾西', ['車路士', 'Chelsea']],
  ['紐卡索聯', ['紐卡素', 'Newcastle United']],
  ['西漢姆聯', ['韋斯咸', 'West Ham United']],
]) {
  const codes = new Set();
  for (const alias of aliases) {
    const resolved = teams.resolve(alias);
    assert.equal(resolved?.key, expected, alias);
    assert.equal(teams.resolve(`${alias}[主]`)?.key, expected, `${alias} with home marker`);
    codes.add(resolved.code);
  }
  assert.equal(codes.size, 1, `${expected}: aliases must share one stable Reader code`);
}
for (const value of ['高雲地利-角球數', '高雲地利-罰牌數', '高雲地利-罚牌数', 'Hull City CORNERS', 'Portsmouth BOOKINGS']) {
  assert.equal(teams.resolve(value), null, 'prop names are never match-team aliases');
}
console.log('PASS soccer supplementary club aliases: Chinese Reader and official English identities share stable keys/codes; existing aliases remain unchanged and corner/card names are excluded.');
