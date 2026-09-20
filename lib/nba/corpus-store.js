import {createHash} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {durableDatabaseUrl} from '../database-url.js';
import {validDate,ESPN_NBA_TEAMS} from './identity.js';
const aliases={GSW:'GS',NOP:'NO',NYK:'NY',SAS:'SA',UTA:'UTAH',WAS:'WSH'};
const validTeam=t=>Object.values(ESPN_NBA_TEAMS).includes(aliases[t]||t);
const stable=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?`[${x.map(stable).join(',')}]`:`{${Object.keys(x).sort().map(k=>`${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
export const corpusRevision=x=>createHash('sha256').update(stable(x)).digest('hex');
const requireValue=(ok,message)=>{if(!ok){const e=new Error(message);e.code='NBA_CORPUS_INVALID';throw e;}};
export function validateNbaCorpus(p){
 requireValue(p?.league==='NBA'&&p.kind==='nba-odds-corpus-shadow-research'&&p.strictPointInTime===false&&p.modelInputEnabled===false,'僅接受 NBA 歷史研究報告');
 requireValue(/^[a-f0-9]{64}$/.test(p.sourceHash||'')&&Number.isFinite(Date.parse(p.generatedAt)),'缺少來源雜湊或研究時間');
 requireValue(Array.isArray(p.entries)&&p.entries.length>0&&p.entries.length<=20000&&new Set(p.entries.map(e=>e.key)).size===p.entries.length,'場次清單缺失或重複');
 let snapshots=0,included=0,matched=0;const ids=new Set(),errors=[],base=[];
 for(const e of p.entries){
  requireValue(typeof e.key==='string'&&validDate(e.candidateDate)&&e.key===`${e.candidateDate.slice(5)}|${e.away}|${e.home}`&&e.away!==e.home&&validTeam(e.away)&&validTeam(e.home),'場次身分無效');
  requireValue(e.gameId===null||/^nba:espn:game:[1-9]\d+$/.test(e.gameId),'跨聯盟或無效比賽 ID');
  requireValue(Array.isArray(e.sourceRows)&&e.sourceRows.length===e.snapshotCount&&e.snapshotCount>0&&e.sourceRows.every(id=>typeof id==='string'&&!ids.has(id)&&(ids.add(id),true)),'原始快照重複或數量不符');
  requireValue(e.marketBacktestEligible===false&&Array.isArray(e.reasons)&&e.reasons.every(r=>typeof r==='string'),'盤口證據狀態無效');
  requireValue(['included_home_team_chronological_fold','pending'].includes(e.researchStatus),'研究狀態無效');
  snapshots+=e.snapshotCount;if(e.gameId)matched++;
  if(e.researchStatus==='included_home_team_chronological_fold'){
   const f=e.fold,d=f?.historicalDiagnostics;requireValue(e.gameId&&f?.gameId===e.gameId&&f.date===e.candidateDate&&f.trainingThrough<f.date&&Number.isInteger(f.trainingRows)&&f.trainingRows>=12,'逐時驗證資料或截止日無效');
   requireValue(d&&['predictedOwn','predictedOpponent','actualOwn','actualOpponent','baselineOwn','baselineOpponent'].every(k=>typeof d[k]==='number'&&Number.isFinite(d[k])),'歷史預測或實際比分缺失');
   errors.push(d.predictedOwn-d.actualOwn,d.predictedOpponent-d.actualOpponent);base.push(d.baselineOwn-d.actualOwn,d.baselineOpponent-d.actualOpponent);included++;
  }
 }
 requireValue(p.summary?.candidateGames===p.entries.length&&p.summary.rawSnapshots===snapshots&&p.summary.providerMatched===matched&&p.summary.researchIncluded===included&&p.summary.marketBacktestEligible===0,'摘要場數無法對帳');
 requireValue(p.candidateSubsetMetrics?.games===included,'研究樣本數不符');
 for(const [name,xs] of [['model',errors],['baseline',base]]){const m=p.candidateSubsetMetrics[name];if(!xs.length){requireValue(m===null,'無樣本不得填績效');continue;}requireValue(m?.samples===xs.length,'績效分母不符');const actual={mae:xs.reduce((s,x)=>s+Math.abs(x),0)/xs.length,rmse:Math.sqrt(xs.reduce((s,x)=>s+x*x,0)/xs.length),bias:xs.reduce((s,x)=>s+x,0)/xs.length};for(const k of Object.keys(actual))requireValue(Number.isFinite(m[k])&&Math.abs(actual[k]-m[k])<=1e-8,'績效算術無法對帳');}
 return p;
}
let client,schema;
function sql(){const url=durableDatabaseUrl();if(!url)throw Error('NBA 研究資料庫未設定');return client||=neon(url);}
async function init(){schema||=sql()`CREATE TABLE IF NOT EXISTS sports_nba_corpus_v1 (revision TEXT PRIMARY KEY, generated_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (payload->>'league'='NBA'))`.catch(e=>{schema=null;throw e;});await schema;}
export async function saveNbaCorpus(payload){validateNbaCorpus(payload);await init();const revision=corpusRevision(payload);await sql()`INSERT INTO sports_nba_corpus_v1 (revision,generated_at,payload) VALUES (${revision},${payload.generatedAt},${JSON.stringify(payload)}::jsonb) ON CONFLICT DO NOTHING`;const rows=await sql()`SELECT payload FROM sports_nba_corpus_v1 WHERE revision=${revision}`;requireValue(rows.length===1&&corpusRevision(rows[0].payload)===revision,'資料庫讀回雜湊不符');validateNbaCorpus(rows[0].payload);return {persisted:true,revision,candidateGames:payload.entries.length};}
export async function loadNbaCorpus(){await init();const rows=await sql()`SELECT revision,payload FROM sports_nba_corpus_v1 ORDER BY generated_at DESC,created_at DESC LIMIT 1`;if(!rows.length)return null;requireValue(corpusRevision(rows[0].payload)===rows[0].revision,'保存的研究雜湊不符');return validateNbaCorpus(rows[0].payload);}
