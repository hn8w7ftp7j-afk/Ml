// Client-safe specification and availability audit. No database, secrets or model imports.
// AVAILABLE means the named observation is present, never a model-validation PASS.
export const SOCCER_REQUIREMENTS_VERSION = '2.2';

const layer = (key, title, items) => Object.freeze({
  key, title, items: Object.freeze(items.map(([key, label]) => Object.freeze({ key, label }))),
});

export const SOCCER_REQUIREMENT_LAYERS = Object.freeze([
  layer('history', '歷史實力', [
    ['strength', '歷史進失球與基礎攻守'], ['xg', '非十二碼 xG／xGA 與射門品質'],
    ['opponents', '對手強度'], ['recency', '近期狀態與時間衰減'],
    ['homeAway', '主客場與中立場'], ['scoreState', '比分、人數與紅牌狀態修正'],
    ['goalSources', '運動戰、定位球與十二碼拆分'], ['teamChanges', '升班、轉會與換帥'],
  ]),
  layer('personnel', '當場人員', [
    ['lineups', '兩隊先發與替補名單'], ['injuries', '兩隊傷停、復出與分鐘限制'],
    ['suspensions', '兩隊停賽與賽事資格'], ['rotation', '輪休、負荷與可能輪換'],
    ['minutes', '先發、替補及未出場的分鐘情境'], ['replacements', '替代者差距與責任轉移'],
    ['combinations', '先發組合、位置與戰術適配'], ['finishingKeepers', '終結能力與門將 PSxG 收縮'],
    ['prematch', '名單公布前的賽前快照'], ['publishedLineups', '公布先發後的核對'],
    ['lateChanges', '開賽前臨時撤換與延期'], ['actualMinutes', '賽後實際上場與分鐘稽核'],
  ]),
  layer('conditions', '比賽條件', [
    ['referee', '裁判身分、公布與更換'], ['refereeEffects', '裁判判罰、紅牌、十二碼與補時'],
    ['restTravel', '全賽程體能、休息與旅行'], ['tactics', '戰術對位與定位球角色'],
    ['weatherVenue', '場地、草皮與當時天氣預報'], ['competition', '賽事階段與歐冠回合、跨聯賽強度'],
  ]),
  layer('score', '比分機率', [
    ['scoreDistribution', '全場比分聯合分布與尾端'], ['halfTime', '上半場模型與時間一致性'],
  ]),
  layer('payoff', '實際收益', [
    ['readerQuotes', 'Reader 實際盤口、身分與盤種'], ['contract', '期間、盤位、邊界損益與取消契約'],
    ['rebate', '實際賠付與有效退水基礎'], ['wrs', '逐比分損益與既有 W／R／S'],
  ]),
  layer('reliability', '可靠程度', [
    ['revisions', '原始觀察、分析與後續版本追溯'],
    ['sourceTimes', '來源時間、取得時間與分析可用性'], ['historicalPit', '歷史賽前資料與完整母體'],
    ['rolling', '時序訓練、驗證與未用資料驗收'], ['calibration', '比分與各市場機率校準'],
    ['uncertainty', '情境、期望收益與實現損益的不確定性'], ['selection', '八方向篩選、分母與同場關聯'],
    ['production', 'API、資料庫、介面與完整使用流程'],
  ]),
]);

// These describe implementation gaps; they are not acceptance thresholds or new W/R/S rules.
export const SOCCER_REQUIREMENTS_GATES = Object.freeze([
  { code: 'SOCCER_MARKET_CONTRACT_UNVERIFIED', label: '足球盤口契約尚未完成核對', reason: '尚須核對本帳戶適用的邊界派彩、取消及延期條款；已確認的期間規則與退水不需重報，也不能據此預設為國際亞盤。' },
  { code: 'SOCCER_MODEL_PIT_UNVERIFIED', label: '歷史賽前可得性尚未驗證', reason: '現有歷史比分是事後回補，不能追認為當時系統已知。' },
  { code: 'SOCCER_HALF_TIME_MODEL_UNVERIFIED', label: '上半場模型尚未正式驗收', reason: '半場研究分布與回顧誤差仍須接受實際盤口校準及未用資料驗收。' },
  { code: 'SOCCER_XG_PLAYER_EFFECTS_UNVERIFIED', label: 'xG 與球員分鐘效果尚未驗證', reason: '名單觀察不代表傷停、輪休、分鐘及組合效果已進入模型。' },
  { code: 'SOCCER_CALIBRATION_VALIDATION_UNVERIFIED', label: '正式校準與完整篩選尚未驗收', reason: '回顧性比分診斷不能當成未用資料、實際收益或信賴區間涵蓋的證明。' },
  { code: 'SOCCER_MODEL_NOT_PROMOTED', label: '足球模型仍為研究狀態', reason: '不啟用正式 W／R／S、候選排名或投注功能。' },
].map(Object.freeze));

const BASELINE_VERSION = 'SOCCER-POISSON-DC-RESEARCH-v1';
const unavailable = new Set(['UNKNOWN', 'UNVERIFIED', 'NOT_AVAILABLE', 'NOT_PUBLISHED', 'IDENTITY_CONFLICT', 'MISSING']);
const datePresent = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const observation = value => {
  if (!value || typeof value !== 'object' || unavailable.has(value.status)) return false;
  return ['value', 'data', 'players', 'observations'].some(key => value[key] !== undefined && value[key] !== null);
};
const item = (status, reason, modelUsage = 'NOT_AVAILABLE') => ({ status, reason, modelUsage });
const unknown = reason => item('UNKNOWN', reason);
const observed = reason => item('PARTIAL', reason, 'OBSERVED_ONLY');
const available = (reason, modelUsage = 'OBSERVED_ONLY') => item('AVAILABLE', reason, modelUsage);

/** Inventory only: this function cannot promote a model or certify a provider contract. */
export function buildSoccerRequirementAudit({ evidence = null, prediction = null, halfTimePrediction = null, reader = null, providerPolicy = null, validation = null } = {}) {
  const game = evidence?.game;
  const validScope = evidence?.ok === true && ['epl', 'ucl'].includes(game?.league)
    && /^\d+$/.test(game.sourceId || '') && game.id === `soccer:${game.league}:${game.sourceId}`
    && [game.home?.sourceId, game.away?.sourceId].every(id => typeof id === 'string' && /^\d+$/.test(id))
    && game.home.sourceId !== game.away.sourceId;
  const teams = ['home', 'away'].map(side => evidence?.teams?.[side]);
  const baseline = validScope && prediction?.modelVersion === BASELINE_VERSION
    && prediction.status === 'RESEARCH_ONLY' && prediction.executable === false
    && /^[a-f0-9]{64}$/.test(prediction.trainingHash || '')
    && [prediction.homeRate, prediction.awayRate].every(value => Number.isFinite(value) && value > 0);
  const hasRecent = ['home', 'away'].some(side => Array.isArray(evidence?.recent?.[side]) && evidence.recent[side].length);
  const starterGroups = teams.map(team => Array.isArray(team?.lineup?.starters) ? team.lineup.starters : []);
  const starters = starterGroups.flat();
  const completeXi = teams.every(team => team?.lineup && !unavailable.has(team.lineup.status))
    && starterGroups.every(players => players.length === 11 && players.every(player => /^\d+$/.test(player.id || '')))
    && new Set(starters.map(player => player.id)).size === 22;
  const hasXi = starters.length > 0;
  const confirmedXi = validScope && completeXi && datePresent(evidence?.observedAt)
    && teams.every(team => team.lineup.independentlyConfirmed === true && datePresent(team.lineup.sourcePublishedAt)
      && Date.parse(team.lineup.sourcePublishedAt) <= Date.parse(evidence.observedAt));
  const both = (field, label) => {
    const present = teams.map(team => observation(team?.[field]));
    if (present.every(Boolean)) return observed(`兩隊${label}資料已有觀察；來源覆蓋、賽前可得性與模型效果仍須核對。`);
    if (present.some(Boolean)) return observed(`${present[0] ? '客隊' : '主隊'}${label}資料仍未知，不能以另一隊取代。`);
    return unknown(`兩隊${label}資料尚未接入或驗證。`);
  };
  const listedMinutes = starters.some(player => Number.isFinite(player.expectedMinutes));
  const hasMinutes = listedMinutes || teams.some(team => observation(team?.minutes));
  const hasPositions = starters.some(player => Boolean(player.position)) || teams.some(team => Boolean(team?.lineup?.formation));
  const playerWorkloadSides = ['home', 'away'].filter(side => {
    const team = evidence?.workload?.teams?.[side], workload = team?.playerWorkload;
    return validScope && team?.ok === true && workload?.ok === true
      && workload.sourceId === game[side].sourceId && Array.isArray(workload.players) && workload.players.length > 0;
  });
  const actual = evidence?.minutesAudit;
  const actualBothTeams = actual?.status === 'REGULATION_CLOCK_RECONSTRUCTED'
    && ['home', 'away'].every(side => Array.isArray(actual.teams?.[side]?.players) && actual.teams[side].players.length > 0);
  const officials = Array.isArray(evidence?.referee?.officials) ? evidence.referee.officials.filter(person => person?.name) : [];
  const readerGames = Array.isArray(reader?.games) ? reader.games : [];
  const scopedReader = readerGames.filter(value => value?.officialGameId === game?.id && value.matchStatus === 'MATCHED');
  const marketCount = scopedReader.reduce((count, value) => count + (Array.isArray(value.markets) ? value.markets.filter(market => ['HANDICAP', 'TOTAL'].includes(market?.kind)).length : 0), 0);
  const readerHasQuotes = readerGames.some(value => Array.isArray(value?.markets) && value.markets.length > 0);
  const hasValidation = (Number.isFinite(validation?.test?.metrics?.count) && validation.test.metrics.count > 0)
    || (Number.isFinite(validation?.metrics?.count) && validation.metrics.count > 0)
    || [validation?.folds, validation?.rolling?.folds].some(folds => Array.isArray(folds) && folds.length > 0)
    || Object.values(validation?.leagues || {}).some(value => Array.isArray(value?.folds) && value.folds.length > 0);
  const results = {
    strength: baseline ? available('研究版基線已使用歷史進失球估計攻守；不代表完整 xG 或球員模型。', 'USED_BASELINE') : unknown('尚無可辨識的研究版比分預測，不能確認本場基礎攻守輸入。'),
    xg: observation(evidence?.xg) ? observed('已觀察到 xG 資料；同源歷史、口徑與模型效果尚未驗證。') : unknown('一致口徑的非十二碼 xG／xGA 與射門品質歷史尚未接入。'),
    opponents: baseline ? available('研究版同賽事攻守模型包含對手參數；歐冠跨聯賽映射仍未建立。', 'USED_BASELINE') : unknown('本場尚無可辨識的對手強度模型輸出。'),
    recency: baseline ? available('研究版基線採歷史時間衰減；近期五場不再另作固定加分。', 'USED_BASELINE') : hasRecent ? observed('僅觀察到部分近期比賽；不等於完整賽程、衰減模型或體能資料。') : unknown('尚無可用的歷史衰減模型或近期比賽觀察。'),
    homeAway: baseline ? available('研究版基線使用主場效果與中立場標記；不代表球隊主客差異已完整驗證。', 'USED_BASELINE') : validScope ? available('主客隊身分可辨識；模型中的場地效果尚未使用。') : unknown('主客隊與賽事身分尚不可辨識。'),
    scoreState: actualBothTeams ? observed('有賽後換人與紅牌分鐘觀察；尚未形成歷史比分／人數狀態修正模型。') : unknown('歷史比分、人數及紅牌事件的條件修正尚未建立。'),
    goalSources: unknown('運動戰、非十二碼定位球與十二碼尚未形成互斥的歷史建模資料。'),
    teamChanges: unknown('升班、轉會與換帥的生效時間、先驗及模型效果尚未驗證。'),
    lineups: confirmedXi ? available('兩隊完整先發及公布時間可觀察；名單存在不代表球員效果已納入模型。') : hasXi ? observed(completeXi ? '兩隊各十一人已由來源回報；公布時間與獨立確認尚未完成。' : '兩隊先發尚未完整核對，不能以單隊名單宣稱完成。') : unknown('兩隊可核對的先發名單尚未取得。'),
    injuries: both('injuries', '傷停與復出'),
    suspensions: both('suspensions', '停賽與資格'),
    rotation: playerWorkloadSides.length ? observed(`已觀察${playerWorkloadSides.length===2?'兩隊':playerWorkloadSides[0]==='home'?'主隊':'客隊'}部分球員近7／14日上場分鐘、出場與先發；缺場次、國家隊及未來輪休仍未知，不由歷史負荷直接推定輪換。`) : unknown('輪休與可能輪換尚未有可核對資料；不能由最近五場直接認定。'),
    minutes: hasMinutes ? observed('已觀察到部分預計分鐘；兩隊互斥出場情境、換人限制與模型驗證仍未完成。') : unknown('兩隊預計分鐘、替補登場及未出場情境尚未建立；賽後分鐘不能代替預測。'),
    replacements: starters.some(player => Boolean(player.replacementId)) ? observed('有部分替代人選觀察；替補差距、責任轉移與多人交互作用尚未驗證。') : unknown('實際替代人選、位置責任與能力差值尚未建模。'),
    combinations: hasPositions ? observed('已觀察位置或陣型；先發組合與戰術交互效果尚未納模。') : unknown('先發位置、陣型與組合效果尚未核對。'),
    finishingKeepers: unknown('射手終結、門將 PSxG 與樣本收縮尚未建模；普通 xGA 不能冒充門將能力。'),
    prematch: validScope && evidence?.phase === 'PREMATCH_OBSERVATION' ? observed('有當時賽前觀察；不代表已保存名單公布前的預估機率與完整情境。') : unknown('目前不是可辨識的賽前觀察，不能當成原始賽前預估。'),
    publishedLineups: hasXi ? observed('已觀察先發名單；公布前後版本與實際公布時間仍須逐版核對。') : unknown('尚無可核對的兩隊公布先發。'),
    lateChanges: unknown('臨時撤換、裁判更換與延期的事件更新及完整覆蓋尚未驗證。'),
    actualMinutes: actualBothTeams ? observed('兩隊正規計時分鐘已有賽後重建；不含實際補時，不作賽前預計分鐘。') : unknown('尚無兩隊完整的賽後分鐘稽核；未完賽不能提前核對。'),
    revisions: evidence?.source?.contentHash && datePresent(evidence?.observedAt) ? observed('有來源雜湊與觀察時間；此函式不證明已持久化或完成三階段版本對照。') : unknown('來源雜湊或觀察時間缺失，不能確認版本追溯。'),
    referee: officials.length ? observed('來源已回報裁判身分；公布時間、臨時更換與效果估計仍未核對。') : unknown('裁判身分尚未公布或來源未提供；不猜測身分。'),
    refereeEffects: unknown('裁判判罰歷史、球隊風格校正與樣本外效果尚未建立。'),
    restTravel: ['home','away'].every(side=>evidence?.workload?.teams?.[side]?.ok===true&&evidence.workload.teams[side].sources?.length>0) ? observed(playerWorkloadSides.length ? '已觀察兩隊跨賽事賽程及部分球員正規時鐘分鐘；開球間隔不是實際休息時長，補時、旅行、國家隊及完整覆蓋仍未驗證。' : '已觀察兩隊跨賽事賽程、近期場數及相鄰開球間隔；不是實際休息時長，分鐘、旅行與完整覆蓋仍未驗證。') : observation(evidence?.travel) ? observed('已有體能／旅行觀察；全賽程覆蓋與模型效果尚未驗證。') : unknown('全賽程分鐘、休息、跨國旅行與國家隊返程尚未完整取得。'),
    tactics: hasPositions ? observed('有部分位置與陣型觀察；對位、定位球角色及交互作用尚未建模。') : unknown('戰術對位與定位球責任尚無可核對模型資料。'),
    weatherVenue: observation(evidence?.weather) ? observed('已有天氣觀察；須核對是否為當時預報及場地狀態，尚未納模。') : game?.venue ? observed('僅有球場名稱；草皮狀態與當時天氣預報尚未接入。') : unknown('場地狀態與當時天氣預報尚未接入。'),
    competition: game?.league === 'ucl' ? observation(evidence?.uclContext) ? observed('已觀察部分歐冠情境；跨聯賽、回合及總比分效果尚未驗證。') : unknown('歐冠階段、已完成回合總比分與跨聯賽實力尚未完整核對。') : validScope ? available('本場為英超，歐冠兩回合與跨聯賽映射不適用；不宣稱戰意效果已建模。') : unknown('賽事身分未知，不能判定回合與跨聯賽需求。'),
    scoreDistribution: baseline && Array.isArray(prediction.cells) && prediction.cells.length > 0 && Number.isFinite(prediction.tailMass) ? available('有研究版全場比分分布及尾端誤差；不是正式校準或實際盤口收益驗收。', 'USED_BASELINE') : unknown('尚無可辨識的本場全場比分聯合分布與尾端紀錄。'),
    halfTime: halfTimePrediction?.period === 'REGULATION_HT' && halfTimePrediction?.jointContract?.halfTimeNeverExceedsFullTime === true ? available('已用歷史半場資料建立與全場相容的研究分布；尚未完成正式盤口校準及未用資料驗收。', 'USED_BASELINE') : unknown('目前沒有適用的半場研究預測；不能把全場勝率除二，半場賽果也不等於預測模型。'),
    readerQuotes: marketCount > 0 ? observed(`本場已匹配 ${marketCount} 筆讓球／大小盤觀察；期間、契約及${scopedReader.every(value => value.fresh === true) ? '實際接受價' : '新鮮度'}仍須核對。`) : readerHasQuotes ? observed('Reader 有盤口觀察，但尚未完成本場身分匹配，不能挪用其他比賽。') : unknown('尚無可匹配本場的 Reader 讓球／大小盤觀察。'),
    contract: unknown('本帳戶實際適用的非 ±50 尾碼派彩、拆注或比例機制、取消與延期條款仍待來源核對；各筆原盤的期間標示另行檢查。'),
    rebate: providerPolicy?.rebateRate === 0.01 && providerPolicy.rebateRateStatus === 'USER_CONFIRMED' ? observed(providerPolicy.rebateBasis === 'SETTLED_PRINCIPAL' && providerPolicy.rebateBasisStatus === 'USER_CONFIRMED' && providerPolicy.rebateApplicabilityStatus === 'USER_CONFIRMED' ? '已確認：實際輸贏本金 × 1%；全贏／全輸退 1%、半贏／半輸退 0.5%、贏20%退0.2%、走盤不退。此算式不等於本帳戶完整派彩契約已驗證。' : providerPolicy.rebateBasis === 'TOTAL_PRINCIPAL' && providerPolicy.rebateBasisStatus === 'USER_CONFIRMED' ? '使用者已確認足球退水為投注金額 × 0.01（1%）；適用結算狀態、邊界及取消條款仍待核對，不套用 NBA 的 0.015。' : '使用者已確認足球退水為 0.01（1%）；計算基數及邊界、取消條款仍待核對，不套用 NBA 的 0.015。') : unknown('足球實際賠付與有效退水基礎尚未核對；不預設所有本金皆適用。'),
    wrs: unknown('正式足球 W／R／S 尚未啟用；既有公式與門檻不變，R 未驗證前不解讀為信賴下限。'),
    sourceTimes: evidence?.source?.contentHash && datePresent(evidence.source.fetchedAt) ? observed('有來源雜湊與取得時間；各欄公布時間、分析可用性與歷史證據仍未完整驗證。') : unknown('來源、取得時間或內容雜湊缺失。'),
    historicalPit: unknown('回補歷史比分不等於當時已取得；歷史可得性與完整賽程母體仍未驗證。'),
    rolling: hasValidation ? observed('已有回顧性時序比分診斷；不是新的未用測試，也未驗證交易收益。') : unknown('尚無可辨識的時序驗證紀錄；不能以數學單測代表成效。'),
    calibration: hasValidation ? observed('有研究版比分／勝平負診斷；各方向、可比盤口及篩選後校準尚未驗收。') : unknown('比分與各市場的獨立校準尚未驗收。'),
    uncertainty: unknown('陣容混合、參數區間與實現收益範圍尚未完整建立；模型差異或 R 不作涵蓋率證據。'),
    selection: unknown('正式八方向篩選尚未啟用；候選母體、取消口徑與同場相關的完整回放仍待驗收。'),
    production: unknown('此清單只盤點資料與模型缺口，不代替 Production API、資料庫、手機或操作流程驗收。'),
  };
  const blockers = SOCCER_REQUIREMENTS_GATES.map(({ code, label }) => ({ code, label }));
  if (!validScope) blockers.unshift({ code: 'SOCCER_GAME_SCOPE_UNKNOWN', label: '本場與兩隊身分尚未核對' });
  if (!marketCount) blockers.push({ code: 'SOCCER_MATCHED_READER_QUOTE_MISSING', label: '缺少本場已匹配的實際盤口' });
  if (game?.league === 'ucl') blockers.push({ code: 'SOCCER_UCL_DOMESTIC_MAPPING_UNVERIFIED', label: '歐冠跨聯賽與回合模型尚未驗證' });
  return {
    version: SOCCER_REQUIREMENTS_VERSION,
    layers: SOCCER_REQUIREMENT_LAYERS.map(({ key, title, items }) => ({ key, title, items: items.map(({ key, label }) => ({ key, label, ...results[key] })) })),
    formalReady: false,
    blockers,
  };
}
