import type { Request, Response } from 'express';
import { sendSuccess, parsePagination, buildPaginationMeta } from '../utils/response.util';
import { createOperationSchema, recordSchema, signatureSchema } from '../validators/admin.validator';
import { AppError } from '../middlewares/error.middleware';
import {
  addSignature,
  cancelOperation,
  getOperation,
  getTreasuryState,
  listOperations,
  prepareOperation,
  recordSubmitted,
  submitOperation,
} from '../services/treasury-ops.service';

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return req.user.walletAddress;
}

export async function getTreasury(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await getTreasuryState());
}

export async function createOperation(req: Request, res: Response): Promise<void> {
  const parsed = createOperationSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid operation', parsed.error.flatten().fieldErrors as any);
  }
  const prepared = await prepareOperation(parsed.data.operation, actor(req));
  sendSuccess(res, prepared, 201);
}

export async function listTreasuryOperations(req: Request, res: Response): Promise<void> {
  const { page, limit } = parsePagination(req.query as any);
  const { rows, total } = await listOperations(page, limit);
  sendSuccess(res, rows, 200, buildPaginationMeta(page, limit, total) as any);
}

export async function getTreasuryOperation(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await getOperation(String(req.params.id)));
}

export async function addOperationSignature(req: Request, res: Response): Promise<void> {
  const parsed = signatureSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'signedXdr is required', parsed.error.flatten().fieldErrors as any);
  }
  sendSuccess(res, await addSignature(String(req.params.id), parsed.data.signedXdr, actor(req)));
}

export async function submitTreasuryOperation(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await submitOperation(String(req.params.id)));
}

export async function recordTreasuryOperation(req: Request, res: Response): Promise<void> {
  const parsed = recordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'txHash is required', parsed.error.flatten().fieldErrors as any);
  }
  await recordSubmitted(String(req.params.id), parsed.data.txHash, actor(req));
  sendSuccess(res, { recorded: true });
}

export async function cancelTreasuryOperation(req: Request, res: Response): Promise<void> {
  await cancelOperation(String(req.params.id), actor(req));
  sendSuccess(res, { cancelled: true });
}
