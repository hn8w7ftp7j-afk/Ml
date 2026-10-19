import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { buildSoccerProbabilityAudit } from '../lib/soccer/probability-audit.js';

// Compile the shipped component. The controlled audit below represents two
// forecasts (0.9, 0.05, 0.05), followed by one draw and one away win.
const source=fs.readFileSync('app/soccer/calibration-panel.js','utf8').replace(/export function/g,'function');
const {code}=await transform(source,{filename:'calibration-panel.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const ctx=vm.createContext({React});
vm.runInContext(code,ctx);
const render=props=>renderToStaticMarkup(React.createElement(ctx.SoccerCalibrationPanel,props));
const bins=(index,meanPredicted,observedFrequency)=>Array.from({length:10},(_,i)=>({index:i,lower:i/10,upper:(i+1)/10,upperInclusive:i===9,count:i===index?2:0,sumPredicted:i===index?meanPredicted*2:0,sumObserved:i===index?observedFrequency*2:0,meanPredicted:i===index?meanPredicted:null,observedFrequency:i===index?observedFrequency:null}));
const audit={version:'SOCCER-PROBABILITY-AUDIT-v1',league:'epl',period:'REGULATION_FT',fold:'diagnostic-2025',modelHash:'controlled-ui-fixture',cohort:{sample:4,used:2,excluded:2,reasons:[{code:'MISSING_OUTCOME',count:1},{code:'OTHER_UNVERIFIED_INPUT',count:1}],uniqueGames:4,usedUniqueGames:2,duplicateRecords:0},pooledEventCount:6,classes:{
  home:{count:2,positiveCount:0,ECE_L1:.9,REL_L2:.81,bins:bins(9,.9,0)},
  draw:{count:2,positiveCount:1,ECE_L1:.45,REL_L2:.2025,bins:bins(0,.05,.5)},
  away:{count:2,positiveCount:1,ECE_L1:.45,REL_L2:.2025,bins:bins(0,.05,.5)},
}};
const markup=render({audit,period:'FT',label:'2025 年診斷'});
assert.match(markup,/2025 年診斷｜全場勝平負校準核對/);
assert.match(markup,/可評估 2／4 筆（50\.0%）；排除 2 筆。原始不同賽事 4 場；可評估不同賽事 2 場/);
assert.match(markup,/主勝、和局、客勝各自核對/);
assert.match(markup,/同一場的三種結果不計為三場比賽/);
assert.match(markup,/<th scope="row">主勝<\/th><td>2<\/td><td>0\.9000<\/td><td>0\.8100<\/td>/);
assert.match(markup,/<th scope="row">和局<\/th><td>2<\/td><td>0\.4500<\/td><td>0\.2025<\/td>/);
assert.match(markup,/<th scope="row">客勝<\/th><td>2<\/td><td>0\.4500<\/td><td>0\.2025<\/td>/);
assert.match(markup,/<th scope="row">90–100%<\/th><td>2<\/td><td>90\.0%<\/td><td>0\.0%<\/td>/,'A nonempty bin with zero realized event frequency must retain a true 0%');
assert.match(markup,/<th scope="row">10–&lt;20%<\/th><td>0<\/td><td>—<\/td><td>—<\/td>/,'Empty bins retain no estimated frequency');
assert.match(markup,/缺少可核對比分：1 筆/);
assert.match(markup,/資料或範圍未通過檢查：1 筆/);
assert.match(markup,/OTHER_UNVERIFIED_INPUT/,'Excluded observations retain an inspectable reason code');
assert.match(markup,/少樣本分箱/);
assert.match(markup,/尚未去偏/);
assert.match(markup,/ECE 以 0–1 機率的絕對差表示；REL 是該差的平方/);
assert.match(markup,/不等於完整 Brier 分解/);
assert.match(markup,/事後回補的研究診斷/);
assert.match(markup,/不代表正式驗收通過、下注勝率提高或正收益/);
assert.doesNotMatch(markup,/可評估 6|undefined|NaN|Infinity|已通過正式驗收/);

const halfTime=render({audit:{...audit,period:'REGULATION_HT'},period:'HT'});
assert.match(halfTime,/上半場勝平負校準核對/);
assert.match(halfTime,/上半場分事件校準指標/);
assert.doesNotMatch(halfTime,/全場分事件校準指標/);
const mismatched=render({audit,period:'HT'});
assert.match(mismatched,/尚無可核對的分事件校準資料/);
assert.doesNotMatch(mismatched,/<table|0\.9000/,'Full-time data cannot be silently relabelled as half-time calibration');
const wrongLeague=render({audit,period:'FT',league:'ucl'});
assert.match(wrongLeague,/尚無可核對的分事件校準資料/);
assert.doesNotMatch(wrongLeague,/<table|0\.9000/,'An EPL audit cannot be shown as UCL calibration');
const legacy=render({audit:{bins:[{count:6,meanPredicted:.33,observedFrequency:.33}]},period:'FT'});
assert.match(legacy,/不以主勝、和局與客勝混合後的分箱代替/);
assert.doesNotMatch(legacy,/<table/,'Legacy pooled bins cannot pretend to be classwise audit data');
const unavailable=render({period:'FT'});
assert.doesNotMatch(unavailable,/undefined|NaN|<table/);
const emptyClass={count:0,positiveCount:0,ECE_L1:null,REL_L2:null,bins:bins(-1,null,null)};
const empty=render({audit:{...audit,cohort:{sample:2,used:0,excluded:2,uniqueGames:0},classes:{home:emptyClass,draw:emptyClass,away:emptyClass}},period:'FT'});
assert.match(empty,/<th scope="row">主勝<\/th><td>0<\/td><td>—<\/td><td>—<\/td>/);
assert.match(empty,/可評估 0／2 筆（0\.0%）/);
const unknown=render({audit:{...audit,cohort:{},classes:{}},period:'FT'});
assert.match(unknown,/可評估 未知／未知 筆（—）/);
assert.doesNotMatch(unknown,/undefined|NaN|Infinity/);
const duplicate=render({audit:{...audit,cohort:{...audit.cohort,uniqueGames:1,duplicateRecords:1}},period:'FT'});
assert.match(duplicate,/不同賽事 1 場/);
assert.match(duplicate,/重複賽事紀錄 1 筆/);
assert.match(duplicate,/樣本數不等同獨立比賽數/);
const tailExclusion=render({audit:{...audit,cohort:{...audit.cohort,reasons:[{code:'AUDIT_OMITTED_MASS_EXCEEDS_TOLERANCE',label:'尾端質量超過本報表容許值',count:1}]}},period:'FT'});
assert.match(tailExclusion,/尾端質量超過本報表容許值：1 筆/);
const scope={league:'epl',period:'REGULATION_FT',fold:'controlled-integration',modelHash:'controlled-ui-fixture'};
const actualAudit=buildSoccerProbabilityAudit(['draw','away'].map((actualOutcome,index)=>({...scope,status:'EVALUATED',eventId:String(index+1),probabilities:{home:.9,draw:.05,away:.05},actualOutcome,retainedMass:1,tailMass:0})),scope);
const integrated=render({audit:actualAudit,period:'FT',league:'epl'});
assert.match(integrated,/<th scope="row">主勝<\/th><td>2<\/td><td>0\.9000<\/td><td>0\.8100<\/td>/);
assert.match(integrated,/可評估 2／2 筆（100\.0%）/);
assert.match(integrated,/可評估不同賽事 2 場/);
console.log('PASS shipped calibration JSX: FT/HT and three outcome classes kept separate, actual N vs pooled 3N, exclusions, zero-frequency vs empty bins, ECE/REL labels, legacy fallback and retrospective limits');
