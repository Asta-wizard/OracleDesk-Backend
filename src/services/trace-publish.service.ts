/**
 * Reasoning trace lifecycle after generation (#131):
 *   enqueue → pin the canonical JSON (traceHash = sha256(pinned bytes)) →
 *   wait for the market's on-chain id → reasoning_registry.publish_trace →
 *   confirmed by the indexer's TracePublished event → verified.
 * See src/jobs/trace-publication.worker.ts.
 */
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { verifyTraceHash, sha256Hex } from '../utils/hash.util';
import { Prisma } from '@prisma/client';
import { fetchIpfsBytes } from './ipfs.service';
import { getOnChainTrace, printable } from './chain.service';
import { processPublication } from '../jobs/trace-publication.worker';
import type { TraceAction } from '../lib/trace-actions';
import type { TraceVerification } from '../types';

/**
 * Records that a trace must be published (#131). The row is durable: if
 * pinning, the market's on-chain creation, or the publish call isn't possible
 * yet, src/jobs/trace-publication.worker.ts finishes it later. An immediate
 * best-effort pass runs in the background so the common case stays fast.
 */
export async function enqueueTracePublication(
  params: { traceId: string; payload: Record<string, unknown>; action: TraceAction },
  deps: { prisma?: any; processNow?: boolean } = {},
): Promise<{ id: string }> {
  const db = deps.prisma ?? prisma;
  const row = await db.tracePublication.upsert({
    where: { traceId: params.traceId },
    create: {
      traceId: params.traceId,
      action: params.action,
      payload: printable(params.payload) as Prisma.InputJsonValue,
    },
    update: {},
  });
  if (deps.processNow ?? true) {
    void processPublication(row, { prisma: db }).catch((err) =>
      logger.warn({ err, traceId: params.traceId }, 'Immediate trace publication pass failed; the worker will retry'),
    );
  }
  return { id: row.id };
}

/**
 * Fetches the content at the on-chain CID, hashes the exact bytes and
 * compares them with the on-chain trace_hash (x402/trace-verification.ts).
 */
export async function verifyTraceOnChain(traceId: string): Promise<TraceVerification> {
  const trace = await prisma.reasoningTrace.findUnique({
    where: { id: traceId },
    select: { id: true, onChainTraceId: true, traceHash: true },
  });
  if (!trace) throw new AppError(404, 'TRACE_NOT_FOUND', 'Reasoning trace not found');
  if (trace.onChainTraceId === null) {
    throw new AppError(409, 'TRACE_NOT_PUBLISHED', 'This trace has not been published on-chain yet');
  }

  const onChain = await getOnChainTrace(trace.onChainTraceId);
  const onChainHash = Buffer.from(onChain.trace_hash).toString('hex');
  const bytes = await fetchIpfsBytes(onChain.ipfs_cid);
  const verified = verifyTraceHash(bytes, onChainHash);

  await prisma.reasoningTrace.update({
    where: { id: traceId },
    data: {
      verified,
      lastAuditStatus: verified ? 'VERIFIED' : 'HASH_MISMATCH',
      lastAuditedAt: new Date(),
    },
  });

  return {
    traceId,
    onChainTraceId: trace.onChainTraceId.toString(),
    ipfsCid: onChain.ipfs_cid,
    onChainHash,
    computedHash: sha256Hex(bytes),
    storedHash: trace.traceHash,
    verified,
    verifiedAt: new Date(),
  };
}
