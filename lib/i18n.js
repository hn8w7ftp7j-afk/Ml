const TEAM_NAMES = {
  'Arizona Diamondbacks': '亞利桑那響尾蛇',
  'Athletics': '運動家',
  'Oakland Athletics': '奧克蘭運動家',
  'Atlanta Braves': '亞特蘭大勇士',
  'Baltimore Orioles': '巴爾的摩金鶯',
  'Boston Red Sox': '波士頓紅襪',
  'Chicago Cubs': '芝加哥小熊',
  'Chicago White Sox': '芝加哥白襪',
  'Cincinnati Reds': '辛辛那提紅人',
  'Cleveland Guardians': '克里夫蘭守護者',
  'Colorado Rockies': '科羅拉多洛磯',
  'Detroit Tigers': '底特律老虎',
  'Houston Astros': '休士頓太空人',
  'Kansas City Royals': '堪薩斯市皇家',
  'Los Angeles Angels': '洛杉磯天使',
  'Los Angeles Dodgers': '洛杉磯道奇',
  'Miami Marlins': '邁阿密馬林魚',
  'Milwaukee Brewers': '密爾瓦基釀酒人',
  'Minnesota Twins': '明尼蘇達雙城',
  'New York Mets': '紐約大都會',
  'New York Yankees': '紐約洋基',
  'Philadelphia Phillies': '費城費城人',
  'Pittsburgh Pirates': '匹茲堡海盜',
  'San Diego Padres': '聖地牙哥教士',
  'San Francisco Giants': '舊金山巨人',
  'Seattle Mariners': '西雅圖水手',
  'St. Louis Cardinals': '聖路易紅雀',
  'Tampa Bay Rays': '坦帕灣光芒',
  'Texas Rangers': '德州遊騎兵',
  'Toronto Blue Jays': '多倫多藍鳥',
  'Washington Nationals': '華盛頓國民',
};

const TEAM_SHORT_NAMES = {
  'Arizona Diamondbacks': '響尾蛇',
  Athletics: '運動家',
  'Oakland Athletics': '運動家',
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

const STATUS_NAMES = {
  Scheduled: '預定開打',
  'Pre-Game': '賽前',
  Preview: '賽前',
  Warmup: '暖身中',
  'In Progress': '比賽進行中',
  'Game Over': '比賽結束',
  Final: '已結束',
  Postponed: '延賽',
  Delayed: '延遲',
  Cancelled: '取消',
  Canceled: '取消',
  Suspended: '暫停',
  Completed: '已結束',
  'Delayed Start': '延後開賽',
  'Delayed: Rain': '因雨延遲',
  'Postponed: Rain': '因雨延賽',
};

const VENUE_NAMES = {
  'Angel Stadium': '天使球場',
  'Oriole Park at Camden Yards': '金鶯公園',
  'Fenway Park': '芬威球場',
  'Wrigley Field': '瑞格利球場',
  'Guaranteed Rate Field': '白襪球場',
  'Rate Field': '白襪球場',
  'Progressive Field': '進步球場',
  'Comerica Park': '科美利卡球場',
  'Kauffman Stadium': '考夫曼球場',
  'Yankee Stadium': '洋基體育場',
  'T-Mobile Park': 'T-Mobile 球場',
  'Globe Life Field': '全球人壽球場',
  'Rogers Centre': '羅傑斯中心',
  'Target Field': '標靶球場',
  'loanDepot park': '馬林魚球場',
  'Truist Park': '勇士球場',
  'Great American Ball Park': '大美國球場',
  'Dodger Stadium': '道奇球場',
  'Daikin Park': '大金球場',
  'Minute Maid Park': '美粒果球場',
  'American Family Field': '美國家庭球場',
  'Citi Field': '花旗球場',
  'Citizens Bank Park': '市民銀行球場',
  'PNC Park': 'PNC 球場',
  'Petco Park': '沛可球場',
  'Oracle Park': '甲骨文球場',
  'Busch Stadium': '布許球場',
  'George M. Steinbrenner Field': '史坦布瑞納球場',
  'Coors Field': '庫爾斯球場',
  'Chase Field': '大通球場',
  'Nationals Park': '國民球場',
  'Sutter Health Park': '薩特健康球場',
};

const ROOF_NAMES = {
  open: '開放式球場',
  retractable: '可開闔屋頂',
  closed: '屋頂關閉',
  dome: '室內球場',
  unknown: '屋頂狀態未知',
};

export function teamNameZh(value) {
  return TEAM_NAMES[String(value || '')] || String(value || '');
}

export function teamDisplayNameZh(value) {
  const source = String(value || '');
  if (TEAM_SHORT_NAMES[source]) return TEAM_SHORT_NAMES[source];
  const translated = TEAM_NAMES[source] || source;
  const match = Object.entries(TEAM_NAMES).find(([, chinese]) => chinese === translated);
  return match ? TEAM_SHORT_NAMES[match[0]] : translated;
}

export function statusNameZh(value) {
  return STATUS_NAMES[String(value || '')] || String(value || '未公布');
}

export function venueNameZh(value) {
  return VENUE_NAMES[String(value || '')] || String(value || '未公布球場');
}

export function roofNameZh(value) {
  return ROOF_NAMES[String(value || '')] || '屋頂狀態未知';
}

export function translateTeamText(value) {
  let text = String(value || '');
  const entries = Object.entries(TEAM_NAMES).sort((a, b) => b[0].length - a[0].length);
  for (const [english, chinese] of entries) {
    text = text.replaceAll(english, TEAM_SHORT_NAMES[english] || chinese);
  }
  for (const [english, chinese] of entries.sort((a, b) => b[1].length - a[1].length)) {
    text = text.replaceAll(chinese, TEAM_SHORT_NAMES[english] || chinese);
  }
  return text;
}

export function matchupZh(game) {
  return `${teamDisplayNameZh(game?.away)} 對 ${teamDisplayNameZh(game?.home)}`;
}

export const TEAM_NAME_MAP = TEAM_NAMES;
export const TEAM_SHORT_NAME_MAP = TEAM_SHORT_NAMES;
