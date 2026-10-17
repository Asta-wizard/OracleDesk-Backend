import axios from 'axios';
import { config } from '../config';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { canonicalBytes, sha256Hex } from '../utils/hash.util';
import { getContentStore } from './content-store.service';

const PINATA_BASE = 'https://api.pinata.cloud';

/**
 * Where JSON documents are pinned. The default talks to Pinata; tests inject
 * an in-memory implementation with `setIpfsTransport`.
 */
export interface IpfsTransport {
  /** Pins `bytes` exactly as given and returns the CID. */
  pin(bytes: Buffer, name: string): Promise<string>;
  /** Returns the exact bytes stored under `cid`. */
  fetch(cid: string): Promise<Buffer>;
}

export const pinataTransport: IpfsTransport = {
  async pin(bytes, name) {
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
      timeout: 20_000,
    });
    return data.IpfsHash;
  },

  async fetch(cid) {
    const gateways = [config.IPFS_GATEWAY_URL, 'https://ipfs.io/ipfs'];
    for (const gateway of gateways) {
      const url = `${gateway.replace(/\/$/, '')}/${encodeURIComponent(cid)}`;
      try {
        // arraybuffer: we need the bytes, not a parsed-and-reserialised object.
        const { data } = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 15_000 });
        return Buffer.from(data);
      } catch {
        logger.warn({ url }, 'IPFS gateway failed, trying next');
      }
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
export async function pinJson(document: unknown, name: string): Promise<PinnedDocument> {
  const bytes = canonicalBytes(document);
  const hash = sha256Hex(bytes);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cid = await transport.pin(bytes, name);
      // Write-through: the pin succeeded, so a cache failure must not fail the
      // caller (the CID/hash are still returned and persisted).
      await getContentStore()
        .put({ cid, sha256: hash, bytes, origin: 'PINNED', verifiedBy: 'pin' })
        .catch((err) => {
          logger.warn({ err, cid, name }, 'IPFS content store write failed; continuing');
        });
      logger.info({ name, cid, hash }, 'Pinned to IPFS');
      return { cid, hash, bytes };
    } catch (err) {
      lastError = err;
      if (err instanceof AppError && err.code === 'IPFS_NOT_CONFIGURED') break;
      if (attempt === 1) {
        logger.warn({ name }, 'IPFS pin failed, retrying in 3s');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  if (lastError instanceof AppError) throw lastError;
  logger.error({ err: lastError, name }, 'IPFS pin failed after retry');
  throw new AppError(502, 'IPFS_UPLOAD_FAILED', 'Failed to pin document to IPFS', { name });
}

export function fetchIpfsBytes(cid: string): Promise<Buffer> {
  return transport.fetch(cid);
}

/**
 * Returns bytes for `cid` only if they match `expectedSha256` (the on-chain
 * hash or the hash computed at pin time). Cache hits are re-hashed on read;
 * a cached row with a different hash is ignored and never served. Gateway
 * bytes are stored only after they verify. Bytes that fail verification are
 * still returned (so callers can report `verified: false`) but never cached.
 */
export async function fetchVerifiedBytes(
  cid: string,
  expectedSha256: string,
  verifiedBy: string,
): Promise<{ bytes: Buffer; source: 'cache' | 'gateway' }> {
  const expected = expectedSha256.toLowerCase().replace(/^0x/, '');
  const store = getContentStore();

  const cached = await store.get(cid);
  if (cached) {
    const storedHash = cached.sha256.toLowerCase().replace(/^0x/, '');
    if (storedHash === expected && sha256Hex(cached.bytes) === expected) {
      await store.touch(cid).catch(() => undefined);
      return { bytes: cached.bytes, source: 'cache' };
    }
    logger.warn(
      { cid, expected, stored: cached.sha256 },
      'Cached IPFS content hash does not match expected hash; consulting gateway',
    );
  }

  const bytes = await transport.fetch(cid);
  const matches = sha256Hex(bytes) === expected;
  if (matches && bytes.length <= config.IPFS_CACHE_MAX_OBJECT_BYTES) {
    await store
      .put({ cid, sha256: expected, bytes, origin: 'GATEWAY_VERIFIED', verifiedBy })
      .catch((err) => logger.warn({ err, cid }, 'Failed to cache verified gateway bytes'));
  } else if (!matches) {
    logger.warn({ cid, expected, computed: sha256Hex(bytes) }, 'Gateway bytes failed hash verification; not cached');
  }
  return { bytes, source: 'gateway' };
}
