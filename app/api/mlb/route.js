import { NextResponse } from 'next/server';
import { fetchSchedule, localDateString } from '../../../lib/mlb';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get('date') || localDateString();
    const games = await fetchSchedule(date);
    return NextResponse.json({ ok: true, date, games });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}
