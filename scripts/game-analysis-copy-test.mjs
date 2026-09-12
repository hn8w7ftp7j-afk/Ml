import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load } from 'cheerio';
import { analysisCardText, buildGameAnalysisCopy, writeAnalysisClipboard } from '../lib/game-analysis-copy.js';

// Parse real HTML, then expose the small standard DOM interface used by the
// serializer. Closed details stay closed; their descendants still exist.
function card(html, selector = '#one') {
  const $ = load(html);
  const adapt = node => node.type === 'text'
    ? { nodeType: 3, textContent: node.data }
    : { nodeType: 1, tagName: node.name?.toUpperCase(), textContent: $(node).text(),
      childNodes: (node.children || []).map(adapt), matches: selector => $(node).is(selector) };
  return adapt($(selector)[0]);
}
const html = `<section id="one"><h2>國民 對 道奇</h2><p>Andrew Alvarez 對 Justin Wrobleski</p>
<div data-analysis-copy-controls><button>複製完整分析</button><span>已複製完整分析</span></div>
<details><summary>核心人員資料</summary><details><summary>打線、牛棚來源</summary><pre>{
  "zero": 0,
  "missing": null,
  "source": "https://official.example/stat?season=2026&amp;team=119",
  "status": "PROJECTED"
}</pre></details></details>
${Array.from({length:8},(_,i)=>`<div><h3>方向 ${i+1}</h3><strong>S ${7+i/10}</strong><p>W +3%｜R -1%｜QA BLOCK</p></div>`).join('')}
<div class="rowActions"><button>取消下注</button><span>私人帳本金額</span></div></section>
<section id="two"><h2>別場比賽</h2></section>`;
const root = card(html);
const body = analysisCardText(root);
for (const expected of ['Andrew Alvarez', 'Justin Wrobleski', '打線、牛棚來源', '"zero": 0', '"missing": null', 'PROJECTED', 'season=2026&team=119', '方向 8', 'QA BLOCK']) assert.ok(body.includes(expected), expected);
assert.equal((body.match(/方向 \d/g) || []).length, 8);
assert.doesNotMatch(body, /別場比賽|取消下注|私人帳本金額|已複製/);
const receipt = { game:{leagueId:'MLB',gamePk:823903,gameDate:'2026-09-07T02:10:00Z'}, analysis:{modelVersion:'old-model',dataVersion:'old-data',analysisAsOf:'2026-09-07T00:26:00Z',dataAsOf:null,lineAsOf:null,results:[{readerVersion:'2.1.19'}]}, persistence:{confirmed:false,snapshotId:'MLB:823903:FULL:original'}, appVersion:'new-ui', retained:true, copiedAt:'2026-09-08T12:00:00Z' };
const original = JSON.stringify(receipt);
const exported = buildGameAnalysisCopy(root, receipt);
assert.match(exported,/分析模型：old-model｜資料版本：old-data/);
assert.match(exported,/複製時網站版本：new-ui/);
assert.match(exported,/資料截至：未記錄｜分析盤口時間：未記錄/);
assert.match(exported,/保存確認：尚未確認/);
assert.match(exported,/保留結果/);
assert.match(exported,/08:26:00（台灣時間）/);
assert.ok(exported.includes(receipt.persistence.snapshotId));
assert.equal(JSON.stringify(receipt),original);
assert.equal(buildGameAnalysisCopy(root,receipt),exported);
const researchReceipt = structuredClone(receipt);
researchReceipt.analysis.results = [{ market: '全場大小', direction: 'over', pick: '大8.5', water: .94, weightedEV: .2, robustEV: .1, score: 8.9 }];
const researchBefore = JSON.stringify(researchReceipt);
const researchCopy = buildGameAnalysisCopy(root, researchReceipt);
assert.match(researchCopy, /currentUsagePolicy/);
assert.match(researchCopy, /"candidateEligible": false/);
assert.match(researchCopy, /歷史模擬 ROI 與實際帳本 ROI 分開統計/);
assert.equal(JSON.stringify(researchReceipt), researchBefore, 'copy policy never mutates archived model fields');
researchReceipt.game.leagueId = 'NPB';
assert.match(buildGameAnalysisCopy(root, researchReceipt), /"currentUsagePolicy": null/, 'MLB-only policy must not leak to NPB');
for (const leagueId of ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL']) {
  const scoped = structuredClone(receipt);
  scoped.game.leagueId = leagueId;
  scoped.analysis.results = [{ market: 'FULL_SPREAD', pick: 'test', water: .95, lineAsOf: '2026-09-07T00:20:00Z', readerGameMarketHash: 'frozen-market', readerPayloadHash: 'frozen-payload' }];
  const copy = buildGameAnalysisCopy(root, scoped);
  assert.ok(copy.includes(`聯盟：${leagueId}`));
  assert.match(copy, /frozen-market/);
  assert.match(copy, /2026-09-07T00:20:00Z/);
  assert.match(copy, /重播結論僅適用於實際查核的快照 ID/);
  assert.match(copy, /"readerVersion": null/, 'never invent absent per-direction lineage');
}
assert.throws(()=>analysisCardText(null));
console.log('PASS collapsed nested details, all eight directions, missing/zero, game isolation and original version/time receipts');

let saved;
await writeAnalysisClipboard(exported,{clipboard:{writeText:async text=>{saved=text;}},document:null});
assert.equal(saved,exported);
function legacy(success) {
  const calls=[];
  const area={style:{},focus(){calls.push('focus');},select(){calls.push('select');},setSelectionRange(a,b){calls.push([a,b]);},remove(){calls.push('remove');}};
  const document={activeElement:{focus(){calls.push('restore');}},createElement(){return area;},body:{appendChild(){}},execCommand(command){calls.push(command);return success;}};
  return {document,area,calls};
}
const fallback=legacy(true);
await writeAnalysisClipboard(exported,{clipboard:{writeText:async()=>{throw Error('permission denied');}},document:fallback.document});
assert.equal(fallback.area.value,exported);
assert.ok(fallback.calls.includes('copy'));
assert.ok(fallback.calls.includes('remove'));
assert.ok(fallback.calls.includes('restore'));
const failure=legacy(false);
await assert.rejects(writeAnalysisClipboard(exported,{clipboard:null,document:failure.document}));
assert.ok(failure.calls.includes('remove'));
await assert.rejects(writeAnalysisClipboard(exported,{clipboard:null,document:null}));
console.log('PASS exact clipboard payload, permission fallback, truthful failure and cleanup');

const page=fs.readFileSync(new URL('../app/page.js',import.meta.url),'utf8');
const component=fs.readFileSync(new URL('../app/game-analysis-copy.js',import.meta.url),'utf8');
assert.match(page,/<section className="gameCard" ref=\{analysisCardRef\}>/);
assert.match(page,/<GameAnalysisCopy[^\n]*cardRef=\{analysisCardRef\}[^\n]*game: displayedGame/);
assert.match(component,/text = buildGameAnalysisCopy\(cardRef.current, receipt\);\s*setManualText\(text\);\s*await writeAnalysisClipboard\(text\);\s*setState\('copied'\)/);
assert.match(component,/manualText && showText/);
assert.match(component,/檢視本次複製文字/);
assert.match(component,/if \(busy.current \|\| !available\) return/);
assert.match(component,/finally \{ busy.current = false; \}/);
assert.match(component,/readOnly value=\{manualText\}/);
assert.doesNotMatch(component,/fetch\(|oneClickAnalyze|onBet|onCancel/);
console.log('PASS per-card wiring and copy-only action boundary; actual clipboard interaction requires browser acceptance');
