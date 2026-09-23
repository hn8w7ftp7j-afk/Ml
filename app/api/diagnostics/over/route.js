import { researchRelocated } from '../../../../lib/research-relocation.js';
import { MLB_RESEARCH_URL } from '../../../../lib/research-location.js';

export const dynamic = 'force-dynamic';
export async function GET(request) { return researchRelocated(request, MLB_RESEARCH_URL); }
