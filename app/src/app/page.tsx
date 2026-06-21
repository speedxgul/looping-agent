import Dashboard from '@/components/Dashboard';
import { loadLedger, loadMemory } from '@/lib/ledger';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const [ledger, memory] = await Promise.all([loadLedger(), loadMemory()]);
  return (
    <main>
      <Dashboard
        serverNow={Date.now()}
        initial={{
          ledger: ledger.data,
          ledgerOk: ledger.ok,
          memory: memory.data,
          memoryOk: memory.ok
        }}
      />
    </main>
  );
}
