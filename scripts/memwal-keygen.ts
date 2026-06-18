/**
 * Generate an Ed25519 delegate key for Walrus Memory (MemWal).
 *
 * Usage:
 *   bun scripts/memwal-keygen.ts
 *
 * Then, at https://staging.memory.walrus.xyz (testnet):
 *   1. Connect a Sui wallet and create a MemWalAccount (gives you MEMWAL_ACCOUNT_ID).
 *   2. Register the printed delegate public key / Sui address on that account.
 *   3. Put MEMWAL_ACCOUNT_ID and MEMWAL_DELEGATE_KEY (the private key below) in .env,
 *      and set MEMWAL_ENABLED=true.
 *
 * The private key is a bearer credential for your agent's memory — store it
 * securely and never commit it.
 */
import { generateDelegateKey } from '@mysten-incubation/memwal/account';

async function main(): Promise<void> {
  const delegate = await generateDelegateKey();
  const publicKeyHex = Buffer.from(delegate.publicKey).toString('hex');

  console.log('\nGenerated MemWal delegate key:\n');
  console.log(`  MEMWAL_DELEGATE_KEY (private, keep secret) = ${delegate.privateKey}`);
  console.log(`  delegate public key (hex)                  = ${publicKeyHex}`);
  console.log(`  delegate Sui address                       = ${delegate.suiAddress}`);
  console.log('\nNext steps:');
  console.log('  1. Create a MemWalAccount at https://staging.memory.walrus.xyz and copy its account id.');
  console.log('  2. Register the delegate Sui address above on that account.');
  console.log('  3. Set MEMWAL_ENABLED=true, MEMWAL_ACCOUNT_ID=<account id>, MEMWAL_DELEGATE_KEY=<private key>.\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memwal-keygen failed: ${message}`);
  process.exitCode = 1;
});
