import { NextResponse } from 'next/server';
export const dynamic='force-dynamic';
export async function GET(){return NextResponse.json({ok:true,version:'3.0.0',aiGatewayConfigured:Boolean(process.env.AI_GATEWAY_API_KEY),time:new Date().toISOString()})}
