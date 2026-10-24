import '../../reader/soccer-teams.js';

// Match-time aliases only: keep the installed Reader's keys, codes, raw capture
// and canonical wire hash unchanged. These observed board spellings resolve to
// exact provider club names; there is no substring or fuzzy-name matching.
const aliases = [
  ['賓福特', 'Brentford'],
  ['般尼茅夫', 'AFC Bournemouth'],
  ['列斯聯', 'Leeds United'],
  ['新特蘭', 'Sunderland'],
  ['葉士域治', 'Ipswich Town'],
  ['諾定咸森林', 'Nottingham Forest'],
  ['費倫巴治', 'Fenerbahce'],
  ['沙巴巴庫', 'Sabah FK'],
  ['多蒙特', 'Borussia Dortmund'],
  ['拿玻里', 'Napoli'],
  ['波杜基林特', 'Bodo/Glimt'],
  ['史特加', 'VfB Stuttgart'],
  ['馬德里體育會', 'Atlético Madrid'],
  ['波圖', 'FC Porto'],
  ['PSV燕豪芬', 'PSV Eindhoven'],
  ['AEK雅典', 'AEK Athens'],
  ['維拉利爾', 'Villarreal'],
  ['巴迪斯拉華', 'Slovan Bratislava'],
  ['巴黎聖日門', 'Paris Saint-Germain'],
  ['巴塞隆拿', 'Barcelona'],
];
const baseKey = value => globalThis.Tai888SoccerTeams.key(value);
const matchAliases = new Map(aliases.map(([alias, official]) => [baseKey(alias), baseKey(official)]));

export function soccerReaderMatchTeamKey(value) {
  const key = baseKey(value);
  return key == null ? null : matchAliases.get(key) || key;
}
