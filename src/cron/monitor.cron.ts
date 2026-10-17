import cron from 'node-cron';
import { runTraderCycle } from '../agents/trader.agent';
import { expireStaleSubscriptions } from '../services/subscription.service';
import { logger } from '../lib/logger';
import { config } from '../config';
import { postgresContentStore } from '../services/content-store.service';

let traderRunning = false;

/**
 * Position Monitor Cron — runs every 15 minutes.
 *
 * Responsibilities:
 * 1. Run the Trader Agent cycle (scan markets, update positions, hedge)
 * 2. Expire stale subscriptions
 *
 * Separate guard flags prevent the Trader Agent from overlapping with itself.
 */
export function startMonitorCron(): void {
  // Trader Agent — every 15 minutes
  cron.schedule('5,20,35,50 * * * *', async () => {
    if (traderRunning) {
      logger.warn('Monitor cron: trader cycle still running — skipping');
      return;
    }

    traderRunning = true;
    try {
      await runTraderCycle();
    } catch (err) {
      logger.error({ err }, 'Monitor cron: trader cycle failed');
    } finally {
      traderRunning = false;
    }
  });

  // Subscription expiry — every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await expireStaleSubscriptions();
    } catch (err) {
      logger.error({ err }, 'Monitor cron: subscription expiry failed');
    }
  });

  // IPFS content eviction (#100) — hourly at :30, bounded batches.
  cron.schedule('30 * * * *', async () => {
    try {
      const result = await postgresContentStore.evict(config.IPFS_CACHE_BUDGET_BYTES);
      if (result.removed > 0) logger.info(result, 'Monitor cron: evicted IPFS content');
    } catch (err) {
      logger.error({ err }, 'Monitor cron: IPFS content eviction failed');
    }
  });

  logger.info('Monitor cron started');
}