// Display aliases only. Club identity and competition membership remain provider data.
// Exact normalized names avoid confusing clubs such as Inter and Inter Miami.
const CLUB_NAMES = [
  ['兵工廠', 'Arsenal', 'Arsenal FC'],
  ['曼城', 'Manchester City', 'Man City', 'Manchester City FC'],
  ['曼聯', 'Manchester United', 'Man United', 'Manchester United FC'],
  ['熱刺', 'Tottenham Hotspur', 'Tottenham', 'Tottenham Hotspur FC'],
  ['利物浦', 'Liverpool', 'Liverpool FC'],
  ['切爾西', 'Chelsea', 'Chelsea FC'],
  ['阿斯頓維拉', 'Aston Villa', 'Aston Villa FC'],
  ['伯恩茅斯', 'AFC Bournemouth', 'Bournemouth'],
  ['布倫特福德', 'Brentford', 'Brentford FC'],
  ['布萊頓', 'Brighton & Hove Albion', 'Brighton and Hove Albion', 'Brighton'],
  ['伯恩利', 'Burnley', 'Burnley FC'],
  ['水晶宮', 'Crystal Palace', 'Crystal Palace FC'],
  ['艾佛頓', 'Everton', 'Everton FC'],
  ['富勒姆', 'Fulham', 'Fulham FC'],
  ['里茲聯', 'Leeds United', 'Leeds'],
  ['萊斯特城', 'Leicester City', 'Leicester'],
  ['紐卡索聯', 'Newcastle United', 'Newcastle'],
  ['諾丁漢森林', 'Nottingham Forest', "Nott'm Forest", 'Nottm Forest'],
  ['桑德蘭', 'Sunderland', 'Sunderland AFC'],
  ['西漢姆聯', 'West Ham United', 'West Ham'],
  ['狼隊', 'Wolverhampton Wanderers', 'Wolverhampton', 'Wolves'],
  ['南安普敦', 'Southampton', 'Southampton FC'],
  ['伊普斯維奇', 'Ipswich Town', 'Ipswich'],
  ['謝菲爾德聯', 'Sheffield United'],
  ['盧頓', 'Luton Town'],
  ['皇家馬德里', 'Real Madrid', 'Real Madrid CF'],
  ['巴塞隆納', 'Barcelona', 'FC Barcelona'],
  ['馬德里競技', 'Atletico Madrid', 'Atlético Madrid', 'Atletico de Madrid'],
  ['畢爾包競技', 'Athletic Club', 'Athletic Bilbao'],
  ['比利亞雷亞爾', 'Villarreal', 'Villarreal CF'],
  ['皇家社會', 'Real Sociedad'],
  ['巴黎聖日耳曼', 'Paris Saint-Germain', 'Paris Saint Germain', 'PSG'],
  ['馬賽', 'Marseille', 'Olympique de Marseille'],
  ['摩納哥', 'AS Monaco', 'Monaco'],
  ['里爾', 'Lille', 'LOSC Lille'],
  ['里昂', 'Lyon', 'Olympique Lyonnais'],
  ['拜仁慕尼黑', 'Bayern Munich', 'Bayern München', 'FC Bayern Munich', 'FC Bayern München'],
  ['多特蒙德', 'Borussia Dortmund', 'Dortmund'],
  ['勒沃庫森', 'Bayer Leverkusen', 'Bayer 04 Leverkusen'],
  ['法蘭克福', 'Eintracht Frankfurt'],
  ['RB萊比錫', 'RB Leipzig'],
  ['斯圖加特', 'VfB Stuttgart', 'Stuttgart'],
  ['國際米蘭', 'Internazionale', 'Inter Milan', 'Inter', 'FC Internazionale Milano'],
  ['尤文圖斯', 'Juventus', 'Juventus FC'],
  ['AC米蘭', 'AC Milan', 'Milan'],
  ['拿坡里', 'Napoli', 'SSC Napoli'],
  ['亞特蘭大', 'Atalanta', 'Atalanta BC'],
  ['羅馬', 'AS Roma', 'Roma'],
  ['拉齊奧', 'Lazio', 'SS Lazio'],
  ['本菲卡', 'Benfica', 'SL Benfica'],
  ['波爾圖', 'FC Porto', 'Porto'],
  ['里斯本競技', 'Sporting CP', 'Sporting Lisbon', 'Sporting Clube de Portugal'],
  ['阿賈克斯', 'Ajax', 'Ajax Amsterdam', 'AFC Ajax'],
  ['PSV恩荷芬', 'PSV Eindhoven', 'PSV'],
  ['飛燕諾', 'Feyenoord', 'Feyenoord Rotterdam'],
  ['塞爾提克', 'Celtic', 'Celtic FC'],
  ['格拉斯哥流浪者', 'Rangers', 'Rangers FC'],
  ['加拉塔薩雷', 'Galatasaray', 'Galatasaray SK'],
  ['費內巴切', 'Fenerbahce', 'Fenerbahçe'],
  ['布魯日', 'Club Brugge', 'Club Brugge KV'],
  ['哥本哈根', 'FC Copenhagen', 'FC København', 'Copenhagen'],
  ['薩爾斯堡紅牛', 'FC Salzburg', 'FC Red Bull Salzburg', 'Red Bull Salzburg', 'Salzburg'],
  ['頓內茨克礦工', 'Shakhtar Donetsk'],
  ['奧林匹亞科斯', 'Olympiacos', 'Olympiakos', 'Olympiacos FC'],
  ['布拉格斯拉維亞', 'Slavia Prague', 'Slavia Praha', 'SK Slavia Praha'],
  ['布拉格斯巴達', 'Sparta Prague', 'Sparta Praha', 'AC Sparta Praha'],
  ['聖吉羅斯聯', 'Union St.-Gilloise', 'Union Saint-Gilloise'],
];

function normalizedName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const LABELS_BY_NAME = new Map(CLUB_NAMES.flatMap(([label, ...aliases]) => aliases.map(alias => [normalizedName(alias), label])));

export function soccerTeamLabel(team) {
  if (!team || typeof team !== 'object') return '隊名尚未提供';
  const supplied = [team.nameZh, team.displayNameZh].find(value => typeof value === 'string' && value.trim());
  if (supplied) return supplied.trim();
  const officialNames = [team.name, team.displayName].filter(value => typeof value === 'string' && value.trim());
  const names = officialNames.length ? officialNames : [team.shortName].filter(value => typeof value === 'string' && value.trim());
  for (const name of names) {
    const translated = LABELS_BY_NAME.get(normalizedName(name));
    if (translated) return translated;
  }
  return names[0]?.trim() || '隊名尚未提供';
}
