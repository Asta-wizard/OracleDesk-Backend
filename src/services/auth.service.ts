/**
 * Wallet login with a SEP-10 style challenge transaction.
 *
 * The server builds a transaction (sequence 0, so it can never be submitted)
 * signed by AUTH_SIGNING_SECRET. The wallet signs it with `signTransaction`,
 * which every Stellar wallet supports (signMessage/SEP-53 is not universal).
 * Challenges are single-use and expire after CHALLENGE_TTL_SECONDS.
 */
import { Keypair, StrKey, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import { config } from '../config';
import { secret } from '../config/secrets';
import { prisma } from '../lib/prisma';
import { getRedis } from '../lib/redis';
import { AppError } from '../middlewares/error.middleware';
import { signToken } from '../middlewares/auth.middleware';

export const CHALLENGE_TTL_SECONDS = 300;

/** Storage for issued challenges, keyed by transaction hash. */
export interface ChallengeStore {
  put(hash: string, address: string, ttlSeconds: number): Promise<void>;
  /** Atomically returns and deletes the entry (single use). */
  take(hash: string): Promise<string | null>;
}

export const redisChallengeStore: ChallengeStore = {
  async put(hash, address, ttl) {
    await getRedis().set(`auth:challenge:${hash}`, address, 'EX', ttl);
  },
  async take(hash) {
    return getRedis().getdel(`auth:challenge:${hash}`);
  },
};

export class MemoryChallengeStore implements ChallengeStore {
  private readonly entries = new Map<string, { address: string; expires: number }>();
  async put(hash: string, address: string, ttl: number) {
    this.entries.set(hash, { address, expires: Date.now() + ttl * 1000 });
  }
  async take(hash: string) {
    const entry = this.entries.get(hash);
    this.entries.delete(hash);
    return entry && entry.expires > Date.now() ? entry.address : null;
  }
}

let store: ChallengeStore = redisChallengeStore;
export function setChallengeStore(next: ChallengeStore): ChallengeStore {
  const prev = store;
  store = next;
  return prev;
}

const serverKeypair = () => Keypair.fromSecret(secret('AUTH_SIGNING_SECRET'));

export function assertStellarAccount(address: unknown): asserts address is string {
  if (typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address)) {
    throw new AppError(400, 'INVALID_ADDRESS', 'address must be a Stellar public key (G…)');
  }
}

export async function createChallenge(address: unknown): Promise<{
  transaction: string;
  networkPassphrase: string;
  expiresAt: string;
}> {
  assertStellarAccount(address);
  const transaction = WebAuth.buildChallengeTx(
    serverKeypair(),
    address,
    config.AUTH_HOME_DOMAIN,
    CHALLENGE_TTL_SECONDS,
    config.STELLAR_NETWORK_PASSPHRASE,
    config.AUTH_WEB_AUTH_DOMAIN,
  );
  const tx = TransactionBuilder.fromXDR(transaction, config.STELLAR_NETWORK_PASSPHRASE);
  await store.put(tx.hash().toString('hex'), address, CHALLENGE_TTL_SECONDS);
  return {
    transaction,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function verifyChallenge(address: unknown, signed: unknown): Promise<{
  token: string;
  userId: string;
  walletAddress: string;
}> {
  assertStellarAccount(address);
  if (typeof signed !== 'string' || signed.length === 0) {
    throw new AppError(400, 'INVALID_CHALLENGE', 'signed must be a base64 transaction envelope');
  }
  const serverAccount = serverKeypair().publicKey();

  let clientAccountID: string;
  let hash: string;
  try {
    const read = WebAuth.readChallengeTx(
      signed,
      serverAccount,
      config.STELLAR_NETWORK_PASSPHRASE,
      config.AUTH_HOME_DOMAIN,
      config.AUTH_WEB_AUTH_DOMAIN,
    );
    clientAccountID = read.clientAccountID;
    hash = read.tx.hash().toString('hex');
    // readChallengeTx allows a grace period past the time bounds; we don't.
    const maxTime = Number(read.tx.timeBounds?.maxTime ?? 0);
    if (!maxTime || Math.floor(Date.now() / 1000) > maxTime) {
      throw new AppError(401, 'CHALLENGE_EXPIRED', 'The challenge has expired. Request a new one.');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/expired|time ?bounds/i.test(message)) {
      throw new AppError(401, 'CHALLENGE_EXPIRED', 'The challenge has expired. Request a new one.');
    }
    throw new AppError(400, 'INVALID_CHALLENGE', 'The signed challenge could not be read', { reason: message });
  }

  // Single use: consumed here even if a later check fails.
  const issuedFor = await store.take(hash);
  if (!issuedFor) {
    throw new AppError(401, 'CHALLENGE_NOT_FOUND', 'Unknown or already used challenge. Request a new one.');
  }
  if (clientAccountID !== address || issuedFor !== address) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge was issued for a different address');
  }

  let signers: string[];
  try {
    signers = WebAuth.verifyChallengeTxSigners(
      signed,
      serverAccount,
      config.STELLAR_NETWORK_PASSPHRASE,
      [address],
      config.AUTH_HOME_DOMAIN,
      config.AUTH_WEB_AUTH_DOMAIN,
    );
  } catch {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge is not signed by this address');
  }
  if (signers.length !== 1 || signers[0] !== address) {
    throw new AppError(401, 'CHALLENGE_SIGNATURE_INVALID', 'The challenge is not signed by this address');
  }

  const user = await prisma.user.upsert({
    where: { walletAddress: address },
    create: { walletAddress: address },
    update: {},
  });
  return { token: signToken(user.id, user.walletAddress), userId: user.id, walletAddress: address };
}
