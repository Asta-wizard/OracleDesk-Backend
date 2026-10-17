import { Errors as MarketCoreErrors } from '../../generated/market-core';
import { Errors as TreasuryErrors } from '../../generated/treasury';
import { Errors as ResolverErrors } from '../../generated/resolver';
import { Errors as ReasoningRegistryErrors } from '../../generated/reasoning-registry';
import { AppError } from '../../middlewares/error.middleware';

const TABLES: Record<string, Record<number, { message: string }>> = {
  marketCore: MarketCoreErrors,
  treasury: TreasuryErrors,
  resolver: ResolverErrors,
  reasoningRegistry: ReasoningRegistryErrors,
};

/**
 * Name of a contract error, e.g. "SlippageExceeded".
 *
 * The SDK's `Err` takes its message from the spec's doc strings, which are
 * empty for these contracts, so the reliable source is the "Error(Contract,
 * #N)" code in the simulation/host error text, looked up in the binding's
 * `Errors` table.
 */
export function contractErrorName(contract: keyof typeof TABLES, err: unknown, hostErrorText?: string): string | null {
  const text = [hostErrorText ?? '', err instanceof Error ? err.message : String(err)].join(' ');
  const match = text.match(/Error\(Contract, #(\d+)\)/);
  if (match) return TABLES[contract][Number(match[1])]?.message ?? `ContractError${match[1]}`;
  if (err && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error?: { message?: string } }).error;
    if (inner?.message) return inner.message;
  }
  return null;
}

export class ChainError extends AppError {
  constructor(
    message: string,
    public readonly contractError: string | null,
    details?: Record<string, unknown>,
    code = 'CHAIN_ERROR',
  ) {
    super(502, code, message, { contractError, ...details });
    this.name = 'ChainError';
  }
}

export class ArchivedEntryError extends AppError {
  constructor(message = 'Entry is archived on-chain', details?: Record<string, unknown>) {
    super(410, 'ARCHIVED_ENTRY', message, details);
    this.name = 'ArchivedEntryError';
  }
}
