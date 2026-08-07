import { NextResponse } from 'next/server';
import { fetchSchedule, taipeiDate } from '../../../lib/mlb.js';
export const dynamic='force-dynamic';
export async function GET(req){try{const date=new URL(req.url).searchParams.get('date')||taipeiDate();const games=await fetchSchedule(date);return NextResponse.json({ok:true,date,games})}catch(error){return NextResponse.json({ok:false,error:String(error?.message||error)},{status:500})}}
