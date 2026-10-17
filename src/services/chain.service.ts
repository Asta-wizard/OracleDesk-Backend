/**
 * Stellar chain access for the backend.
 *
 * Reads go through read-only binding clients (simulation, no signer).
 * Writes always go through the treasury (`agent_create_market`, `agent_buy`,
 * `agent_sell`) so its on-chain risk caps apply, plus
 * `reasoning_registry.publish_trace`. The backend never calls
 * `market_core.buy` with the agent key.
 *
 * CHAIN_EXECUTION_MODE=dry-run (the default) builds and simulates every
 * write, logs the simulated result and returns it without signing.
 *
 * Why not reuse agents/stellar/adapter.ts from the contracts repo: its
 * dry-run mode returns the arguments without simulating, it imports the
 * bindings by npm package name (not installed here), and it has no
 * agent_sell. This service keeps the same method names and mode semantics
 * so the two can converge (see docs/contract-requests.md).
 */
import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';
import { config } from '../config';
import { logger } from '../lib/logger';
import { agentClients, readClients } from './stellar/clients';
import { ChainError, contractErrorName } from './stellar/errors';
import type { Category, Config as MarketCoreConfig, Market as OnChainMarket, Outcome, Position } from '../generated/market-core';
import type { Trace } from '../generated/reasoning-registry';
import type { DailyUsage, RiskConfig } from '../generated/treasury';
import type { ResolutionState } from '../generated/resolver';

type ContractKey = 'marketCore' | 'treasury' | 'resolver' | 'reasoningRegistry';

export type WriteResult<T> =
  | { mode: 'dry-run'; method: string; value: T; txHash: null }
  | { mode: 'live'; method: string; value: T; txHash: string | null };

export const Outcomes = {
  Yes: { tag: 'Yes', values: undefined } as Outcome,
  No: { tag: 'No', values: undefined } as Outcome,
};

/** Value from a simulated call, unwrapping contract `Result`s into ChainErrors. */
export function simulatedValue<T>(contract: ContractKey, method: string, tx: AssembledTransaction<unknown>): T {
  const sim = tx.simulation as { error?: string } | undefined;
  const hostError = typeof sim?.error === 'string' ? sim.error : undefined;
  let raw: unknown;
  try {
    raw = tx.result;
  } catch (err) {
    throw new ChainError(`${method} simulation failed`, contractErrorName(contract, err, hostError), { method });
  }
  if (raw && typeof raw === 'object' && 'isOk' in raw && typeof (raw as { isOk: unknown }).isOk === 'function') {
    const result = raw as { isOk(): boolean; unwrap(): T };
    if (!result.isOk()) {
      const name = contractErrorName(contract, raw, hostError);
      throw new ChainError(`${method} failed: ${name ?? 'contract error'}`, name, { method });
    }
    return result.unwrap();
  }
  return raw as T;
}

async function read<T>(contract: ContractKey, method: string, call: () => Promise<AssembledTransaction<unknown>>): Promise<T> {
  let tx: AssembledTransaction<unknown>;
  try {
    tx = await call();
  } catch (err) {
    throw new ChainError(`${method} read failed`, contractErrorName(contract, err), {
      method,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  return simulatedValue<T>(contract, method, tx);
}

async function write<T>(
  contract: 'treasury' | 'reasoningRegistry',
  method: string,
  args: Record<string, unknown>,
  call: () => Promise<AssembledTransaction<unknown>>,
): Promise<WriteResult<T>> {
  let tx: AssembledTransaction<unknown>;
  try {
    tx = await call();
  } catch (err) {
    throw new ChainError(`${method} could not be built`, contractErrorName(contract, err), {
      method,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const simulated = simulatedValue<T>(contract, method, tx);

  if (config.CHAIN_EXECUTION_MODE === 'dry-run') {
    logger.info({ method, args: printable(args), simulated: printable(simulated) }, 'dry-run: simulated, not submitted');
    return { mode: 'dry-run', method, value: simulated, txHash: null };
  }

  try {
    const sent = await tx.signAndSend();
    const value = simulatedValueFromSent<T>(contract, method, sent.result);
    const txHash = sent.sendTransactionResponse?.hash ?? null;
    logger.info({ method, txHash }, 'submitted');
    return { mode: 'live', method, value, txHash };
  } catch (err) {
    throw new ChainError(`${method} submission failed`, contractErrorName(contract, err), {
      method,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

function simulatedValueFromSent<T>(contract: ContractKey, method: string, result: unknown): T {
  if (result && typeof result === 'object' && 'isOk' in result) {
    const r = result as { isOk(): boolean; unwrap(): T };
    if (!r.isOk()) throw new ChainError(`${method} failed`, contractErrorName(contract, result), { method });
    return r.unwrap();
  }
  return result as T;
}

/** JSON-safe view (bigint → string, Buffer → hex) for logs and API output. */
export function printable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map(printable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, printable(v)]));
  }
  return value;
}

// ─── Reads ────────────────────────────────────────────────────────────────

export const marketCount = () =>
  read<bigint>('marketCore', 'market_count', async () => (await readClients.marketCore()).market_count());

export const getOnChainMarket = (marketId: bigint) =>
  read<OnChainMarket>('marketCore', 'get_market', async () => readClients.marketCore().get_market({ market_id: marketId }));

export const getPrice = (marketId: bigint, outcome: Outcome) =>
  read<number>('marketCore', 'get_price', async () => readClients.marketCore().get_price({ market_id: marketId, outcome }));

export const quoteBuy = (marketId: bigint, outcome: Outcome, collateralIn: bigint) =>
  read<bigint>('marketCore', 'quote_buy', async () =>
    readClients.marketCore().quote_buy({ market_id: marketId, outcome, collateral_in: collateralIn }),
  );

export const getPosition = (marketId: bigint, holder: string) =>
  read<Position>('marketCore', 'get_position', async () =>
    readClients.marketCore().get_position({ market_id: marketId, holder }),
  );

export const getOnChainTrace = (traceId: bigint) =>
  read<Trace>('reasoningRegistry', 'get_trace', async () => readClients.reasoningRegistry().get_trace({ trace_id: traceId }));

export const resolverState = (marketId: bigint) =>
  read<ResolutionState>('resolver', 'state', async () => readClients.resolver().state({ market_id: marketId }));

export const treasuryAvailableCapital = () =>
  read<bigint>('treasury', 'available_capital', async () => readClients.treasury().available_capital());

export const treasuryConfig = () =>
  read<RiskConfig>('treasury', 'get_config', async () => readClients.treasury().get_config());

export const treasuryDailyUsage = () =>
  read<DailyUsage>('treasury', 'daily_usage', async () => readClients.treasury().daily_usage());

export const marketCoreConfig = () =>
  read<MarketCoreConfig>('marketCore', 'get_config', async () => readClients.marketCore().get_config());

// ─── Writes (through the treasury) ───────────────────────────────────────────

export interface CreateMarketArgs {
  question_hash: Buffer;
  resolution_hash: Buffer;
  meta_uri: string;
  category: Category;
  close_time: bigint;
  seed_amount: bigint;
  initial_yes_bps: number;
}

export const agentCreateMarket = (args: CreateMarketArgs) =>
  write<bigint>('treasury', 'agent_create_market', { ...args }, async () =>
    agentClients.treasury().agent_create_market(args),
  );

export const agentBuy = (args: { market_id: bigint; outcome: Outcome; collateral_in: bigint; min_shares_out: bigint }) =>
  write<bigint>('treasury', 'agent_buy', args, async () => agentClients.treasury().agent_buy(args));

export const agentSell = (args: { market_id: bigint; outcome: Outcome; collateral_out: bigint; max_shares_in: bigint }) =>
  write<bigint>('treasury', 'agent_sell', args, async () => agentClients.treasury().agent_sell(args));

export const publishTrace = (args: {
  agent: string;
  market_id: bigint;
  action: string;
  trace_hash: Buffer;
  ipfs_cid: string;
}) =>
  write<bigint>('reasoningRegistry', 'publish_trace', args, async () =>
    agentClients.reasoningRegistry().publish_trace(args),
  );
