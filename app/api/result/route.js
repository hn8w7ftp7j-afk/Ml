import { NextResponse } from 'next/server';
import { fetchFinalResult } from '../../../lib/mlb.js';
export const dynamic='force-dynamic';
export async function GET(req){try{const gamePk=new URL(req.url).searchParams.get('gamePk');if(!gamePk)return NextResponse.json({ok:false,error:'缺少 gamePk'},{status:400});return NextResponse.json({ok:true,...await fetchFinalResult(gamePk)})}catch(error){return NextResponse.json({ok:false,error:String(error?.message||error)},{status:500})}}
