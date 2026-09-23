import { redirect } from 'next/navigation';
import { MLB_RESEARCH_URL } from '../../../lib/research-location.js';

export const dynamic = 'force-dynamic';
export default function OverResearchMoved() { redirect(MLB_RESEARCH_URL); }
