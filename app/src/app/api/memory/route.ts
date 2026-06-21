import { NextResponse } from 'next/server';
import { loadMemory } from '@/lib/ledger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const { data, ok } = await loadMemory();
  return NextResponse.json(
    { ok, data },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
