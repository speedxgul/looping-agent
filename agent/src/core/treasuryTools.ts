// Non-custodial agent tools (TREASURY_MODE). These replace the wallet-based supply
// flow: funds live in the on-chain Treasury, the enclave decides + signs the allocation,
// and the agent submits the attested verified_supply_* PTB as Submitter (gas only).
//
// Registered by toolRegistry only when `config.treasury.enabled` and a TreasuryClient is
// present, so the existing wallet tools stay intact behind the flag.
import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag } from '@mysten/sui/utils';
import { TreasuryClient as TC } from '../clients/chain/treasuryClient.js';
import type { AppConfig, Clients, LendingProtocol, Logger, OpenAIToolDefinition } from '../types.js';
import type { ReserveCurve } from './allocation.js';
import { supplyLegsNeedingRefresh } from './oracleRefresh.js';
import type { AllocationLeg, AllocationRefs } from './verifiedSupplyTx.js';

const TS = 1_700_000_000_000n;
const PROTOCOLS: LendingProtocol[] = ['suilend', 'navi', 'scallop'];
const EMPTY_PARAMS = { type: 'object', additionalProperties: false, properties: {}, required: [] } as const;

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const canon = (s: string): string => {
  const withPrefix = s.includes('::') && !s.startsWith('0x') ? `0x${s}` : s;
  try {
    return normalizeStructTag(withPrefix).toLowerCase();
  } catch {
    return s.toLowerCase();
  }
};

/** Gather the USDC reserve curve from each allowlisted protocol client. */
async function gatherUsdcCurves(config: AppConfig, clients: Clients): Promise<ReserveCurve[]> {
  const usdcAsset = config.sui.defaultAssets.usdc;
  const curves: ReserveCurve[] = [];
  for (const protocol of PROTOCOLS) {
    if (!config.sui.allowedProtocols.includes(protocol)) continue;
    const client =
      protocol === 'navi' ? clients.navi : protocol === 'scallop' ? clients.scallop : clients.suilend;
    try {
      const coinType = client.resolveCoinType(usdcAsset);
      const market = (await client.getMarkets()).markets.find((m) => canon(m.coinType) === canon(coinType));
      if (market?.curve) curves.push(market.curve);
    } catch {
      // skip a protocol whose markets fail to load
    }
  }
  return curves;
}

/**
 * Assemble the submittable allocation refs from config. `mock` is always available; each
 * real protocol is added only once its shared-object ids are configured (mainnet). A leg
 * whose protocol has no refs is decided by the enclave but not submitted (reported skipped).
 */
export function buildAllocationRefs(
  config: AppConfig,
  treasuryId: string,
  agentCapId: string
): AllocationRefs {
  const base = {
    packageId: config.treasury.packageId,
    coinType: config.sui.usdcCoinType,
    registryId: config.treasury.registryId,
    treasuryId,
    enclaveId: config.treasury.enclaveId,
    agentCapId
  };
  const p = config.treasury.protocols;
  const refs: AllocationRefs = { mock: base };
  if (p.suilend.lendingMarketId && p.suilend.marketType) {
    refs.suilend = {
      ...base,
      marketType: p.suilend.marketType,
      lendingMarketId: p.suilend.lendingMarketId,
      reserveArrayIndex: BigInt(p.suilend.reserveArrayIndex),
      ...(p.suilend.pythPriceInfoObjectId ? { pythPriceInfoObjectId: p.suilend.pythPriceInfoObjectId } : {})
    };
  }
  if (p.scallop.versionId && p.scallop.marketId) {
    refs.scallop = { ...base, versionId: p.scallop.versionId, marketId: p.scallop.marketId };
  }
  if (p.navi.storageId && p.navi.poolId) {
    refs.navi = {
      ...base,
      storageId: p.navi.storageId,
      poolId: p.navi.poolId,
      incentiveV2Id: p.navi.incentiveV2Id,
      incentiveV3Id: p.navi.incentiveV3Id,
      assetId: p.navi.assetId
    };
  }
  return refs;
}

/** Whether a decided leg's protocol has submittable refs on this network. */
export function hasRefFor(refs: AllocationRefs, protocolId: number): boolean {
  if (protocolId === 0) return refs.suilend !== undefined;
  if (protocolId === 1) return refs.scallop !== undefined;
  if (protocolId === 2) return refs.navi !== undefined;
  if (protocolId === 255) return refs.mock !== undefined;
  return false;
}

interface TreasuryToolDeps {
  config: AppConfig;
  clients: Clients;
  logger: Logger;
}

/** The TREASURY_MODE tool handlers (empty if no TreasuryClient is configured). */
export function treasuryToolHandlers({
  config,
  clients,
  logger
}: TreasuryToolDeps): Record<string, ToolHandler> {
  const treasury = clients.treasury;
  if (!treasury) return {};

  return {
    // What the vault lets the agent deploy right now (on-chain budget + authority).
    get_treasury_status: async () => {
      const b = await treasury.readBudget(Date.now());
      return {
        ok: true,
        treasuryId: treasury.treasuryId,
        deployableRaw: b.deployableRaw.toString(),
        remainingPeriodRaw: b.remainingPeriodRaw.toString(),
        perTxCapRaw: b.state.perTxCapRaw.toString(),
        fundsRaw: b.state.fundsRaw.toString(),
        canSupply: b.canSupply,
        reason: b.reason ?? null,
        agentActive: b.state.agentCapId !== null,
        expiryMs: b.state.expiryMs
      };
    },

    // The protocol positions custodied inside the Treasury (the receipts).
    get_treasury_positions: async () => {
      const positions = await treasury.readPositions();
      return { ok: true, treasuryId: treasury.treasuryId, count: positions.length, positions };
    },

    // The full non-custodial supply: read budget → ask the enclave to decide+sign the
    // allocation → submit the executable legs as one atomic PTB (agent pays gas only).
    treasury_supply: async () => {
      const budget = await treasury.readBudget(Date.now());
      if (!budget.canSupply) return { ok: false, submitted: false, reason: budget.reason ?? 'cannot supply' };

      const curves = await gatherUsdcCurves(config, clients);
      if (curves.length === 0)
        return { ok: false, submitted: false, reason: 'no reserve curves available to allocate across' };

      const legs = await treasury.decide({
        curves,
        depositRaw: budget.deployableRaw,
        perTxCapRaw: budget.state.perTxCapRaw,
        nonce: BigInt(Date.now()),
        expiresAtMs: BigInt(Date.now() + 600_000),
        assetType: Array.from(new TextEncoder().encode(config.sui.defaultAssets.usdc.toUpperCase())),
        chainId: [4],
        timestampMs: TS
      });

      const decision = legs.map((l) => ({
        protocol: TC.protocolName(l.intent.protocolId),
        protocolId: l.intent.protocolId,
        amountRaw: l.intent.amount.toString(),
        nonce: l.intent.nonce.toString()
      }));

      // Submit only legs whose protocol has configured refs; the rest are decided but
      // skipped (e.g. a real protocol whose mainnet object ids aren't in config yet).
      const refs = buildAllocationRefs(config, treasury.treasuryId, treasury.agentCapId);
      const executable: AllocationLeg[] = legs.filter((l) => hasRefFor(refs, l.intent.protocolId));
      const skipped = decision.filter((d) => !hasRefFor(refs, d.protocolId));

      if (executable.length === 0) {
        return {
          ok: true,
          submitted: false,
          decision,
          note: 'The enclave decided this allocation, but no leg has configured refs to submit. Add the chosen protocol(s) shared-object ids to config (TREASURY_<PROTOCOL>_* env) to execute real legs.'
        };
      }

      try {
        // If a Suilend leg is being submitted with a configured Pyth PriceInfoObject,
        // prepend its reserve-price refresh: Suilend's deposit recomputes ctoken value and
        // aborts on a stale reserve price. PTB commands execute in order, so the refresh
        // goes onto a fresh tx BEFORE the supply legs. No-op when the only live leg is mock.
        let prelude: Transaction | undefined;
        if (supplyLegsNeedingRefresh(executable).has(0) && refs.suilend?.pythPriceInfoObjectId) {
          prelude = new Transaction();
          await clients.suilend.addReserveRefresh(
            prelude,
            refs.suilend.pythPriceInfoObjectId,
            refs.suilend.reserveArrayIndex
          );
        }
        const tx = treasury.buildSupplyTx(executable, refs, TS, prelude);
        const result = await clients.suiExecution.signAndExecute(tx);
        logger.info('treasury_supply submitted attested allocation', {
          digest: result.digest,
          legs: executable.length,
          oracleRefresh: prelude ? 'suilend-reserve' : 'none'
        });
        return { ok: true, submitted: true, digest: result.digest, decision, skipped };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, submitted: false, decision, error: message.slice(0, 200) };
      }
    }
  };
}

/** The TREASURY_MODE tool schemas exposed to the model. */
export function treasuryToolDefinitions(): OpenAIToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'get_treasury_status',
      description:
        'Read the on-chain non-custodial Treasury: deployable budget (idle funds bounded by the remaining period cap), per-tx cap, whether the agent is still authorized (not revoked/expired), and canSupply. This is the budget the agent may deploy — NOT a wallet balance.',
      parameters: EMPTY_PARAMS
    },
    {
      type: 'function',
      name: 'get_treasury_positions',
      description:
        'List the protocol positions custodied inside the Treasury (one receipt per protocol: Suilend obligation cap, Scallop sCoin, NAVI account cap). These are the vault positions; only the owner can withdraw them.',
      parameters: EMPTY_PARAMS
    },
    {
      type: 'function',
      name: 'treasury_supply',
      description:
        'Non-custodially deploy the Treasury budget: reads the deployable budget, asks the attested enclave to DECIDE the optimal allocation (the enclave picks the protocols + amounts and signs each leg), then submits the executable legs as one atomic verified_supply transaction. The agent only pays gas; funds move from the Treasury, not a wallet. Prefer this over lending_supply when TREASURY_MODE is on.',
      parameters: EMPTY_PARAMS
    }
  ];
}
