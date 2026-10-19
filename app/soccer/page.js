import { redirect } from 'next/navigation';

// Preserve saved football links while keeping the league workspace on the home page.
export default async function SoccerPage({ searchParams }) {
  const params = await searchParams || {};
  const league = String(params.league || params.sport || 'EPL').toUpperCase() === 'UCL' ? 'UCL' : 'EPL';
  const query = new URLSearchParams({ sport: league });
  if (/^\d{4}-\d{2}-\d{2}$/.test(params.date || '')) query.set('date', params.date);
  if (['schedule', 'upcoming', 'standings'].includes(params.view)) query.set('view', params.view);
  if (/^[a-zA-Z0-9_:-]{8,300}$/.test(params.runId || '')) query.set('runId', params.runId);
  redirect(`/?${query}`);
}
