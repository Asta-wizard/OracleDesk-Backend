/**
 * Reasoning trace lifecycle after generation:
 *   pin the canonical JSON → traceHash = sha256(pinned bytes) →
 *   reasoning_registry.publish_trace (dry-run simulates) → verify.
 */
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { verifyTraceHash, sha256Hex } from '../utils/hash.util';
import { fetchVerifiedBytes, pinJson } from './ipfs.service';
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
    data: { onChainTraceId: result.value, publishTxHash: result.txHash, verified: true },
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
  const { bytes, source } = await fetchVerifiedBytes(
    onChain.ipfs_cid,
    onChainHash,
    `reasoning_registry:trace:${trace.onChainTraceId}`,
  );
  const verified = verifyTraceHash(bytes, onChainHash);

  await prisma.reasoningTrace.update({ where: { id: traceId }, data: { verified } });

  return {
    traceId,
    onChainTraceId: trace.onChainTraceId.toString(),
    ipfsCid: onChain.ipfs_cid,
    onChainHash,
    computedHash: sha256Hex(bytes),
    storedHash: trace.traceHash,
    verified,
    contentSource: source,
    verifiedAt: new Date(),
  };
}

/**
 * Generalises pin+publish for documents that do not have a ReasoningTrace row
 * (transparency reports, #159). Returns the mode so callers can mark dry runs.
 */
export async function pinAndPublishDocument(params: {
  document: unknown;
  name: string;
  action: string;
  marketId: bigint;
}, options: { dryRun?: boolean } = {}): Promise<{ cid: string; hash: string; onChainTraceId: bigint | null; publishTxHash: string | null; mode: 'dry-run' | 'live' }> {
  const pinned = await pinJson(params.document, params.name);
  if (options.dryRun) {
    return { cid: pinned.cid, hash: pinned.hash, onChainTraceId: null, publishTxHash: null, mode: 'dry-run' };
  }
  const published = await publishPinnedDocument({
    cid: pinned.cid,
    hash: pinned.hash,
    action: params.action,
    marketId: params.marketId,
  });
  return { cid: pinned.cid, hash: pinned.hash, ...published };
}

/**
 * Publishes bytes that are already pinned. Used to recover from a crash
 * between pin and publish without recomputing (and re-pinning) the document.
 */
export async function publishPinnedDocument(params: {
  cid: string;
  hash: string;
  action: string;
  marketId: bigint;
}, options: { dryRun?: boolean } = {}): Promise<{ onChainTraceId: bigint | null; publishTxHash: string | null; mode: 'dry-run' | 'live' }> {
  if (options.dryRun) {
    return { onChainTraceId: null, publishTxHash: null, mode: 'dry-run' };
  }
  const result = await publishTrace({
    agent: agentSigner().publicKey as string,
    market_id: params.marketId,
    action: params.action,
    trace_hash: Buffer.from(params.hash, 'hex'),
    ipfs_cid: params.cid,
  });
  if (result.mode === 'dry-run') {
    return { onChainTraceId: null, publishTxHash: null, mode: 'dry-run' };
  }
  return { onChainTraceId: result.value, publishTxHash: result.txHash, mode: 'live' };
}
