import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import { TraceAuditStatus } from '@prisma/client';
import { runTraceAudit } from '../services/trace-audit.service';
import { sendSuccess, sendError, parsePagination, buildPaginationMeta } from '../utils/response.util';
import { logger } from '../lib/logger';

/**
 * GET /admin/trace-audit
 * Returns summary counts by status, the latest audit run details,
 * and paginated non-verified findings (with optional status filtering).
 */
export async function getTraceAuditSummary(req: Request, res: Response): Promise<void> {
  const { page, limit, skip } = parsePagination(req.query as any);
  const statusParam = req.query.status as string | undefined;

  let validStatus: TraceAuditStatus | undefined;
  if (statusParam) {
    if (Object.values(TraceAuditStatus).includes(statusParam as TraceAuditStatus)) {
      validStatus = statusParam as TraceAuditStatus;
    } else {
      sendError(res, 400, 'INVALID_STATUS', `Status must be one of: ${Object.values(TraceAuditStatus).join(', ')}`);
      return;
    }
  }

  const [countsGroup, latestRun, findings, totalFindings] = await Promise.all([
    prisma.traceAudit.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
    prisma.traceAuditRun.findFirst({
      orderBy: { startedAt: 'desc' },
    }),
    prisma.traceAudit.findMany({
      where: validStatus
        ? { status: validStatus }
        : { status: { not: TraceAuditStatus.VERIFIED } },
      skip,
      take: limit,
      orderBy: { checkedAt: 'desc' },
    }),
    prisma.traceAudit.count({
      where: validStatus
        ? { status: validStatus }
        : { status: { not: TraceAuditStatus.VERIFIED } },
    }),
  ]);

  const counts: Record<string, number> = {};
  for (const status of Object.values(TraceAuditStatus)) {
    counts[status] = 0;
  }
  for (const g of countsGroup) {
    counts[g.status] = g._count.status;
  }

  sendSuccess(
    res,
    {
      counts,
      latestRun,
      findings,
    },
    200,
    buildPaginationMeta(page, limit, totalFindings) as any,
  );
}

/**
 * POST /admin/trace-audit/run
 * Starts a trace audit run asynchronously in the background.
 * Returns 202 with the runId.
 */
export async function triggerTraceAuditRun(req: Request, res: Response): Promise<void> {
  const runId = uuidv4();

  // Fire and forget
  runTraceAudit({ runId }).catch((err) => {
    logger.error({ err, runId }, 'Background trace audit run failed');
  });

  sendSuccess(res, { runId, message: 'Trace audit run scheduled' }, 202);
}
