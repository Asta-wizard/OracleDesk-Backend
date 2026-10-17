import cron from 'node-cron';
import { runMarketMakerCycle } from '../agents/market-maker.agent';
import { logger } from '../lib/logger';
import { recordCronRun } from './registry';

let isRunning = false;

/**
 * Schedules the Market Maker Agent to run every 15 minutes.
 *
 * The `isRunning` guard prevents overlapping executions.
 * If a cycle is still running when the next one is scheduled,
 * the new trigger is skipped.
 *
 * Cron expression: "0,15,30,45 * * * *"
 *   Runs at :00, :15, :30, :45 of every hour
 */
export function startIngestionCron(): void {
  cron.schedule('0,15,30,45 * * * *', async () => {
    if (isRunning) {
      logger.warn('Ingestion cron: previous cycle still running — skipping');
      return;
    }

    isRunning = true;
    const startedAt = new Date();
    try {
      await runMarketMakerCycle();
      recordCronRun('ingestion', 'success', startedAt, new Date());
    } catch (err) {
      recordCronRun('ingestion', 'failure', startedAt, new Date(), err);
      logger.error({ err }, 'Ingestion cron: cycle failed');
    } finally {
      isRunning = false;
    }
  });

  logger.info('Ingestion cron started (every 15 minutes)');
}