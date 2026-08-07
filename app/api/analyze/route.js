import { NextResponse } from 'next/server';
import { buildGameContext } from '../../../lib/mlb.js';
import { analyzeMarkets } from '../../../lib/analysis.js';
import { MARKET_ORDER, validateMarketPair } from '../../../lib/markets.js';
export const runtime='nodejs';export const maxDuration=60;export const dynamic='force-dynamic';
export async function POST(req){try{const {game,markets,settings}=await req.json();if(!game?.gamePk||!Array.isArray(markets))return NextResponse.json({ok:false,error:'缺少賽事或盤口資料'},{status:400});const errors=[];for(const name of MARKET_ORDER){const rows=markets.filter(x=>x.market===name);errors.push(...validateMarketPair(name,rows.map(x=>({pick:x.pick,water:x.water}))));}if(errors.length)return NextResponse.json({ok:false,error:`盤口未完整：${[...new Set(errors)].join('、')}`},{status:400});const context=await buildGameContext(game);const analysis=analyzeMarkets({context,markets,settings});return NextResponse.json({ok:true,game,context,analysis})}catch(error){return NextResponse.json({ok:false,error:String(error?.message||error)},{status:500})}}
