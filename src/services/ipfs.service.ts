import axios from 'axios';
import { config } from '../config';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { canonicalBytes, sha256Hex } from '../utils/hash.util';
import { bulkheads, deadline, sleep, TimeoutError } from '../lib/resilience';

const PINATA_BASE = 'https://api.pinata.cloud';

/**
 * Where JSON documents are pinned. The default talks to Pinata; tests inject
 * an in-memory implementation with `setIpfsTransport`.
 */
export interface IpfsTransport {
  /** Pins `bytes` exactly as given and returns the CID. */
  pin(bytes: Buffer, name: string, signal?: AbortSignal): Promise<string>;
  /** Returns the exact bytes stored under `cid`. */
  fetch(cid: string, signal?: AbortSignal): Promise<Buffer>;
}

export const pinataTransport: IpfsTransport = {
  async pin(bytes, name, signal) {
    if (!config.PINATA_API_KEY || !config.PINATA_SECRET_API_KEY) {
      throw new AppError(503, 'IPFS_NOT_CONFIGURED', 'PINATA_API_KEY and PINATA_SECRET_API_KEY are not set');
    }
    // pinFileToIPFS stores the file's bytes verbatim. pinJSONToIPFS would
    // re-serialise the object, so its bytes could differ from what we hashed.
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/json' }), `${name}.json`);
    form.append('pinataMetadata', JSON.stringify({ name }));
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
    const { data } = await axios.post<{ IpfsHash: string }>(`${PINATA_BASE}/pinning/pinFileToIPFS`, form, {
      headers: {
        pinata_api_key: config.PINATA_API_KEY,
        pinata_secret_api_key: config.PINATA_SECRET_API_KEY,
      },
      timeout: config.TIMEOUT_IPFS_PIN_MS,
      signal,
    });
    return data.IpfsHash;
  },

  async fetch(cid, signal) {
    const gateways = [config.IPFS_GATEWAY_URL, 'https://ipfs.io/ipfs'];
    const handle = deadline('ipfs-fetch', signal);

    try {
      for (const gateway of gateways) {
        if (handle.signal.aborted) break;
        const url = `${gateway.replace(/\/$/, '')}/${encodeURIComponent(cid)}`;
        const perGatewayBudget = Math.max(1000, Math.floor(handle.remaining() / gateways.length));
        const gwHandle = deadline('ipfs-fetch', handle.signal, perGatewayBudget);

        try {
          // arraybuffer: we need the bytes, not a parsed-and-reserialised object.
          const { data } = await axios.get<ArrayBuffer>(url, {
            responseType: 'arraybuffer',
            timeout: perGatewayBudget,
            signal: gwHandle.signal,
            maxContentLength: config.IPFS_MAX_BYTES,
            maxBodyLength: config.IPFS_MAX_BYTES,
          });
          return Buffer.from(data);
        } catch {
          logger.warn({ url }, 'IPFS gateway failed, trying next');
        } finally {
          gwHandle.cleanup?.();
        }
      }
    } finally {
      handle.cleanup?.();
    }

    throw new AppError(502, 'IPFS_RETRIEVAL_FAILED', 'Could not retrieve content from any IPFS gateway', { cid });
  },
};

let transport: IpfsTransport = pinataTransport;

/** Test seam. Returns the previous transport. */
export function setIpfsTransport(next: IpfsTransport): IpfsTransport {
  const prev = transport;
  transport = next;
  return prev;
}

export interface PinnedDocument {
  cid: string;
  /** sha256 hex of the exact bytes pinned. */
  hash: string;
  bytes: Buffer;
}

/** Canonicalises `document`, pins those bytes and returns their hash. Retries once. */
export async function pinJson(
  document: unknown,
  name: string,
  opts?: { signal?: AbortSignal },
): Promise<PinnedDocument> {
  const bytes = canonicalBytes(document);
  const hash = sha256Hex(bytes);
  let lastError: unknown;

  const handle = deadline('ipfs-pin', opts?.signal);

  try {
    return await bulkheads['ipfs-pin'].run(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (handle.signal.aborted) {
          throw handle.signal.reason;
        }

        try {
          const cid = await transport.pin(bytes, name, handle.signal);
          logger.info({ name, cid, hash }, 'Pinned to IPFS');
          return { cid, hash, bytes };
        } catch (err) {
          lastError = err;
          if (opts?.signal?.aborted || handle.signal.aborted) {
            throw (opts?.signal?.reason ?? handle.signal.reason);
          }
          if (err instanceof AppError && err.code === 'IPFS_NOT_CONFIGURED') break;
          if (attempt === 1) {
            logger.warn({ name }, 'IPFS pin failed, retrying in 3s');
            await sleep(3000, handle.signal);
          }
        }
      }

      if (lastError instanceof AppError) throw lastError;
      logger.error({ err: lastError, name }, 'IPFS pin failed after retry');
      throw new AppError(502, 'IPFS_UPLOAD_FAILED', 'Failed to pin document to IPFS', { name });
    }, opts?.signal);
  } finally {
    handle.cleanup?.();
  }
}

export function fetchIpfsBytes(cid: string, signal?: AbortSignal): Promise<Buffer> {
  return bulkheads['ipfs-fetch'].run(async () => {
    try {
      return await transport.fetch(cid, signal);
    } catch (err) {
      if (err instanceof AppError && err.code === 'IPFS_RETRIEVAL_FAILED') {
        throw err;
      }
      if (err instanceof TimeoutError || (err as any)?.code === 'UPSTREAM_TIMEOUT') {
        throw new AppError(502, 'IPFS_RETRIEVAL_FAILED', 'Could not retrieve content from any IPFS gateway', { cid });
      }
      throw err;
    }
  }, signal);
}
