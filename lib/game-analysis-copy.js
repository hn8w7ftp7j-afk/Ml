// Read the rendered card, including closed <details>, without opening sections,
// fetching sources, or recalculating a score. Never include ledger controls.
import { evidenceJSON, settlementEvidence, replayEvidenceView } from './analysis-evidence-export-v2.js';
import { marketResearchPolicy } from './market-research-policy.js';
const BLOCKS = new Set(['SECTION', 'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'DETAILS', 'SUMMARY', 'PRE', 'UL', 'OL', 'LI', 'TR']);
const OMIT = 'button,input,select,textarea,script,style,[data-analysis-copy-controls],.rowActions';

export function analysisCardText(root) {
  if (!root) throw new Error('分析卡片尚未準備好');
  const read = node => {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1 || node.matches(OMIT)) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'PRE') return `\n${node.textContent}\n`;
    const text = Array.from(node.childNodes, read).join('');
    if (node.tagName === 'TD' || node.tagName === 'TH') return `${text}\t`;
    return BLOCKS.has(node.tagName) ? `\n${text}\n` : `${text} `;
  };
  return read(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function time(value) {
  if (value == null || value === '') return '未記錄';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return `${value}（時間格式未確認）`;
  return `${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date)}（台灣時間）`;
}

export function buildGameAnalysisCopy(root, { game, analysis, persistence, appVersion, retained = false, copiedAt = new Date().toISOString() }) {
  const body = analysisCardText(root);
  if (!body) throw new Error('此場尚無可複製的分析內容');
  const readerVersions = [...new Set((analysis.results || []).map(row => row.readerVersion).filter(Boolean))];
  return [
    '整場完整分析（包含收合明細）',
    `聯盟：${game.leagueId || game.league || '未記錄'}｜比賽 ID：${game.gamePk ?? '未記錄'}`,
    `比賽時間：${time(game.gameDate)}`,
    `分析時間：${time(analysis.analysisAsOf || analysis.createdAt)}`,
    `資料截至：${time(analysis.dataAsOf)}｜分析盤口時間：${time(analysis.lineAsOf)}`,
    `分析模型：${analysis.modelVersion || '未記錄'}｜資料版本：${analysis.dataVersion || '未記錄'}`,
    `Reader：${readerVersions.join('、') || '未記錄'}｜複製時網站版本：${appVersion}`,
    `PIT 快照：${persistence?.snapshotId || '未保存'}｜保存確認：${persistence?.confirmed === true ? '已確認' : '尚未確認'}`,
    `輸入雜湊：${analysis.inputHash || '未記錄'}｜比分分布雜湊：${analysis.distributionHash || '未記錄'}`,
    `複製時間：${time(copiedAt)}`,
    retained ? '保留結果：以下含先前保存的分析；畫面附帶的最新 Reader 盤口請依各自時間辨識。' : '以下為此刻卡片已有的分析與資料明細。',
    '複製不會重新分析或更新資料；缺值、替代值與未驗證狀態照原樣保留。',
    'W 是模型估計 EV，R 是模型保守估計；歷史模擬 ROI 與實際帳本 ROI 分開統計，均不等於已知的未來真實 EV。',
    '以下 currentUsagePolicy 是複製時網站的使用狀態，不改寫當時分析、QA、S／W／R 或原下注紀錄。僅供研究的方向不列入候選順序；已自行下注仍須如實記帳。',
    '分析盤口時間為分析記錄的彙總欄位，不代表所有來源於同一時點取得；以下逐方向欄位照原記錄列出，缺值不由卡片來源時間補入。',
    '分析結果所附盤口識別（未重新核驗原始價格）：',
    JSON.stringify((analysis.results || []).map(row => ({
      market: row.market ?? null, pick: row.pick ?? null, water: row.water ?? null,
      lineAsOf: row.lineAsOf ?? null, readerVersion: row.readerVersion ?? null,
      readerGameMarketHash: row.readerGameMarketHash ?? null,
      readerPayloadHash: row.readerPayloadHash ?? null,
      currentUsagePolicy: (() => { const policy = marketResearchPolicy(row, game); return policy ? { id: policy.id, label: policy.label, candidateEligible: false } : null; })(),
    })), null, 2),
    '覆算應註明使用卡片四捨五入機率或 QA JSON 高精度機率；顯示吻合不等於分布來源、R/S 或歷史成效已驗證。重播結論僅適用於實際查核的快照 ID。',
    '整數門檻相同而分盤比例改變，屬部分結算比例調整；若模型分布同時更新，需固定另一項後分別重算，不能直接歸因為單一變動。',
    '保存結果之完整精度結算欄位（不是獨立重播）：',
    evidenceJSON(settlementEvidence(analysis)),
    '重播環境與所屬模型版本驗收（不是單場預測效力證明）：',
    evidenceJSON(replayEvidenceView(analysis.replayEnvironment)),
    '', body,
  ].join('\n');
}

export async function writeAnalysisClipboard(text, { clipboard = globalThis.navigator?.clipboard, document = globalThis.document } = {}) {
  try {
    if (clipboard?.writeText) { await clipboard.writeText(text); return; }
  } catch { /* Browser permission or older mobile support: try selected text. */ }
  const previousFocus = document?.activeElement;
  const selection = document?.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const area = document?.createElement('textarea');
  if (!area || !document.body) throw new Error('請手動複製下方完整文字');
  area.value = text;
  area.readOnly = true;
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  try {
    document.body.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    if (document.execCommand?.('copy') !== true) throw new Error('請手動複製下方完整文字');
  } finally {
    area.remove();
    previousFocus?.focus?.({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}
