import { aggregateSignals } from '../services/ingestion.service';
import {
  generateMarketQuestion,
  isDuplicateMarket,
  createMarketFromProposal,
} from '../services/market.service';
import { generateReasoningTrace } from '../services/reasoning.service';
import { createMarketOnChain } from '../services/market-chain.service';
import { enqueueTracePublication } from '../services/trace-publish.service';
import { TRACE_ACTIONS } from '../lib/trace-actions';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config';
import { deadline } from '../lib/resilience';
import { shutdownController } from '../lib/shutdown';

// Return shape used by the job tracker
export interface MarketCycleResult {
  marketId: string;
  question: string;
  category: string;
  onChainMarketId: string | null;
}

/**
 * Market Maker Agent — main execution loop.
 *
 * Called by the ingestion cron every 15 minutes AND manually via
 * POST /markets/generate. Returns market details on success so the
 * job tracker can surface them in GET /markets/generation-status/:jobId.
 *
 * Returns null when the cycle is intentionally skipped (no signals,
 * duplicate detected, etc.) — not an error condition.
 */
export async function runMarketMakerCycle(opts?: { signal?: AbortSignal }): Promise<MarketCycleResult | null> {
  logger.info('Market Maker Agent: starting cycle');

  const parentSignal = opts?.signal
    ? opts.signal
    : shutdownController.signal;

  const handle = deadline('rpc-write', parentSignal, config.CYCLE_DEADLINE_MS);
  const signal = handle.signal;

  try {
    signal.throwIfAborted();

    // Step 1: Aggregate signals from all sources
    const signals = await aggregateSignals(signal);
    if (signals.signalCount === 0) {
      logger.warn('Market Maker Agent: no signals available — skipping cycle');
      return null;
    }

    signal.throwIfAborted();

    // Step 2: Generate market proposal via the LLM
    let proposal;
    try {
      proposal = await generateMarketQuestion(signals);
    } catch (err) {
      logger.error({ err }, 'Market Maker Agent: market generation failed');
      return null;
    }

    signal.throwIfAborted();

    // Step 3: Deduplicate
    const isDuplicate = await isDuplicateMarket(proposal.market_question);
    if (isDuplicate) {
      logger.info({ question: proposal.market_question },
        'Market Maker Agent: duplicate market — skipping');
      return null;
    }

    signal.throwIfAborted();

    // Step 4: Persist market to DB (PENDING until it exists on-chain)
    const market = await createMarketFromProposal(proposal);
    logger.info({ marketId: market.id, category: market.category }, 'Market Maker Agent: market created in DB');

    // Step 5: Commit the resolution spec and create the market through the
    // treasury. dry-run simulates; the market then stays PENDING.
    // Note: Do not abort between a chain submission and its DB write.
    let onChainMarketId: bigint | null = null;
    try {
      const result = await createMarketOnChain(market);
      if (result.mode === 'live') onChainMarketId = result.value;
    } catch (err) {
      logger.error({ err, marketId: market.id }, 'Market Maker Agent: on-chain creation failed; market stays PENDING');
    }

    signal.throwIfAborted();

    // Step 6: Reasoning trace for the creation decision
    const { trace, tracePayload } = await generateReasoningTrace({
      marketId:            market.id,
      agentType:           'MARKET_MAKER',
      decisionType:        'MARKET_CREATION',
      sourcesUsed:         signals.news.slice(0, 3).map(s => ({
        source:   s.source,
        weight:   0.7,
        signal:   s.title,
        rawValue: proposal.initial_yes_probability,
      })),
      probabilityEstimate: proposal.initial_yes_probability,
      marketProbability:   0.5,
      edge:                proposal.initial_yes_probability - 0.5,
      confidenceInterval:  proposal.confidence_interval,
    });

    signal.throwIfAborted();

    // Step 7: Queue the trace for pinning + publication to reasoning-registry.
    // The queue publishes it once the market is on-chain (#131). The payload is
    // fixed now: re-pinning later with a new onChainMarketId would change traceHash.
    try {
      await enqueueTracePublication({
        traceId: trace.id,
        payload: { ...tracePayload, onChainMarketId: onChainMarketId?.toString() ?? null },
        action: TRACE_ACTIONS.createMarket,
      });
    } catch (err) {
      logger.error({ err, traceId: trace.id }, 'Market Maker Agent: failed to queue trace publication');
    }

    logger.info({ marketId: market.id, traceId: trace.id }, 'Market Maker Agent: cycle complete');

    return {
      marketId: market.id,
      question: market.question,
      category: String(market.category),
      onChainMarketId: onChainMarketId?.toString() ?? null,
    };
  } catch (err) {
    logger.error({ err }, 'Market Maker Agent: unhandled cycle error');

    await prisma.agentLog.create({
      data: {
        agentType: 'MARKET_MAKER',
        level:     'ERROR',
        action:    'CYCLE_FAILED',
        error:     String(err),
      },
    }).catch(() => {});

    throw err; // Re-throw so the job tracker records FAILED status
  } finally {
    handle.cleanup?.();
  }
}
