import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Address, Keypair, Operation, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { integrationEnv, skipReason } from './setup';

let db: Awaited<ReturnType<typeof integrationEnv>>;
let prisma: import('@prisma/client').PrismaClient;
let verification: typeof import('../../src/services/payment-verification.service');
let recordPayment: typeof import('../../src/services/subscription.service').recordPayment;
let truncateAll: typeof import('../helpers/db').truncateAll;
let makeUser: typeof import('../helpers/factories').makeUser;
let usdc: string;
let recipient: string;
let passphrase: string;

before(async () => {
  db = await integrationEnv('payments');
  if (!db) return;
  prisma = (await import('../../src/lib/prisma')).prisma;
  verification = await import('../../src/services/payment-verification.service');
  ({ recordPayment } = await import('../../src/services/subscription.service'));
  ({ truncateAll } = await import('../helpers/db'));
  ({ makeUser } = await import('../helpers/factories'));
  const contracts = await import('../../src/config/contracts');
  usdc = contracts.CONTRACTS.usdc;
  recipient = contracts.PAYMENTS_RECIPIENT;
  passphrase = (await import('../../src/config')).config.STELLAR_NETWORK_PASSPHRASE;
});
beforeEach(async () => { if (db) await truncateAll(prisma); });
after(async () => { if (db) { await prisma.$disconnect(); await db.drop(); } });

const PRICE = 5_000_000n;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: any) => e.code ?? e.message);

/** A successful USDC transfer of the pass price from `from`, served by a fake reader. */
function useTransfer(from: string) {
  const tx = new TransactionBuilder(new Account(from, '1'), { fee: '100', networkPassphrase: passphrase })
    .addOperation(Operation.invokeContractFunction({
      contract: usdc,
      function: 'transfer',
      args: [new Address(from).toScVal(), new Address(recipient).toScVal(), nativeToScVal(PRICE, { type: 'i128' })],
    }))
    .setTimeout(30)
    .build();
  return verification.setTransactionReader({
    async getTransaction(hash: string) {
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: hash, ledger: 42, envelopeXdr: tx.toEnvelope() } as any;
    },
  });
}

test('grants pass once (idempotent re-submit)', { skip: skipReason() }, async () => {
  const user = await makeUser(prisma);
  const prev = useTransfer(user.walletAddress);
  try {
    const hash = 'ab'.repeat(32);
    const args = { userId: user.id, walletAddress: user.walletAddress, type: 'DAILY_PASS' as const, txHash: hash };
    const first = await recordPayment(args);
    const again = await recordPayment(args);
    assert.equal(again.id, first.id);
    assert.equal(await prisma.subscription.count(), 1);
    assert.equal(await prisma.paymentEvent.count(), 1);
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('rejects hash reuse by another user', { skip: skipReason() }, async () => {
  const owner = await makeUser(prisma);
  const other = await makeUser(prisma);
  const hash = 'cd'.repeat(32);
  let prev = useTransfer(owner.walletAddress);
  try {
    await recordPayment({ userId: owner.id, walletAddress: owner.walletAddress, type: 'DAILY_PASS', txHash: hash });
  } finally {
    verification.setTransactionReader(prev);
  }
  prev = useTransfer(other.walletAddress);
  try {
    assert.equal(
      await code(recordPayment({ userId: other.id, walletAddress: other.walletAddress, type: 'DAILY_PASS', txHash: hash })),
      'PAYMENT_ALREADY_USED',
    );
  } finally {
    verification.setTransactionReader(prev);
  }
});

test('concurrent double claim yields one subscription', { skip: skipReason() }, async () => {
  const user = await makeUser(prisma);
  const prev = useTransfer(user.walletAddress);
  try {
    const hash = 'ef'.repeat(32);
    const claim = () => code(recordPayment({ userId: user.id, walletAddress: user.walletAddress, type: 'DAILY_PASS', txHash: hash }));
    const results = await Promise.all([claim(), claim()]);
    // The real payment_events.txHash unique index guarantees one pass.
    assert.equal(await prisma.subscription.count(), 1);
    assert.equal(await prisma.paymentEvent.count(), 1);
    assert.ok(results.includes('ok'));
    // BUG(#135 non-goal): the loser surfaces Prisma's P2002 as a generic error
    // (a 500 over HTTP) instead of a defined PAYMENT_ALREADY_USED.
  } finally {
    verification.setTransactionReader(prev);
  }
});

test.todo('rolls back on mid-transaction failure (needs a fault-injection hook in recordPayment)');
