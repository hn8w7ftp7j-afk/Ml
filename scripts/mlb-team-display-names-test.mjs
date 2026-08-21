import assert from 'node:assert/strict';
import {
  TEAM_NAME_MAP,
  TEAM_SHORT_NAME_MAP,
  matchupZh,
  teamDisplayNameZh,
  teamNameZh,
  translateTeamText,
} from '../lib/i18n.js';

const expected = {
  'Arizona Diamondbacks': '響尾蛇',
  Athletics: '運動家',
  'Atlanta Braves': '勇士',
  'Baltimore Orioles': '金鶯',
  'Boston Red Sox': '紅襪',
  'Chicago Cubs': '小熊',
  'Chicago White Sox': '白襪',
  'Cincinnati Reds': '紅人',
  'Cleveland Guardians': '守護者',
  'Colorado Rockies': '洛磯',
  'Detroit Tigers': '老虎',
  'Houston Astros': '太空人',
  'Kansas City Royals': '皇家',
  'Los Angeles Angels': '天使',
  'Los Angeles Dodgers': '道奇',
  'Miami Marlins': '馬林魚',
  'Milwaukee Brewers': '釀酒人',
  'Minnesota Twins': '雙城',
  'New York Mets': '大都會',
  'New York Yankees': '洋基',
  'Philadelphia Phillies': '費城人',
  'Pittsburgh Pirates': '海盜',
  'San Diego Padres': '教士',
  'San Francisco Giants': '巨人',
  'Seattle Mariners': '水手',
  'St. Louis Cardinals': '紅雀',
  'Tampa Bay Rays': '光芒',
  'Texas Rangers': '遊騎兵',
  'Toronto Blue Jays': '藍鳥',
  'Washington Nationals': '國民',
};

assert.equal(Object.keys(expected).length, 30, 'MLB active team display map must cover 30 teams');
for (const [english, shortName] of Object.entries(expected)) {
  assert.equal(TEAM_SHORT_NAME_MAP[english], shortName, `${english} short name`);
  assert.equal(teamDisplayNameZh(english), shortName, `${english} exact display`);
  assert.equal(teamDisplayNameZh(TEAM_NAME_MAP[english]), shortName, `${english} Chinese display`);
  assert.equal(teamNameZh(english), TEAM_NAME_MAP[english], `${english} canonical Chinese name must remain full`);
}

assert.equal(TEAM_SHORT_NAME_MAP['Oakland Athletics'], '運動家', 'legacy Oakland alias remains display-safe');
assert.equal(matchupZh({ away: 'Atlanta Braves', home: 'Milwaukee Brewers' }), '勇士 對 釀酒人');
assert.equal(matchupZh({ away: '多倫多藍鳥', home: '紐約洋基' }), '藍鳥 對 洋基');
assert.equal(translateTeamText('亞特蘭大勇士讓1平'), '勇士讓1平');
assert.equal(translateTeamText('Toronto Blue Jays 受讓1-90'), '藍鳥 受讓1-90');
assert.equal(translateTeamText('中信兄弟 對 味全龍'), '中信兄弟 對 味全龍', 'other leagues must remain unchanged');

console.log('mlb-team-display-names-test: PASS');
