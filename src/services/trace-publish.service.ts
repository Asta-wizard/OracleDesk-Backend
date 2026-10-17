/**
 * Reasoning trace lifecycle after generation:
 *   pin the canonical JSON → traceHash = sha256(pinned bytes) →
 *   reasoning_registry.publish_trace (dry-run simulates) → verify.
 */
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { verifyTraceHash, sha256Hex } from '../utils/hash.util';
import { fetchIpfsBytes, pinJson } from './ipfs.service';
import { getOnChainTrace, publishTrace } from './chain.service';
import { agentSigner } from './stellar/clients';
import type { TraceVerification } from '../types';

export async function pinAndPublishTrace(params: {
  traceId: string;
  payload: Record<string, unknown>;
  action: string;
  onChainMarketId: bigint | null;
}): Promise<{ cid: string; traceHash: string; onChainTraceId: bigint | null; publishTxHash: string | null }> {
  const pinned = await pinJson(params.payload, `oracledesk-trace-${params.traceId}`);

  await prisma.reasoningTrace.update({
    where: { id: params.traceId },
    data: { ipfsCid: pinned.cid, traceHash: pinned.hash },
  });

  if (params.onChainMarketId === null) {
    logger.info({ traceId: params.traceId }, 'Trace pinned; market not on-chain yet, so not published');
    return { cid: pinned.cid, traceHash: pinned.hash, onChainTraceId: null, publishTxHash: null };
  }

  const result = await publishTrace({
    agent: agentSigner().publicKey as string,
    market_id: params.onChainMarketId,
    action: params.action,
    trace_hash: Buffer.from(pinned.hash, 'hex'),
    ipfs_cid: pinned.cid,
  });

  if (result.mode === 'dry-run') {
    return { cid: pinned.cid, traceHash: pinned.hash, onChainTraceId: null, publishTxHash: null };
  }

  await prisma.reasoningTrace.update({
    where: { id: params.traceId },
    data: { onChainTraceId: result.value, publishTxHash: result.txHash },
  });
  return { cid: pinned.cid, traceHash: pinned.hash, onChainTraceId: result.value, publishTxHash: result.txHash };
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
