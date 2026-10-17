import crypto from 'crypto';
import dotenv from 'dotenv';
import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

dotenv.config();

const optionalString = z.string().default('');

const stellarAccount = z
  .string()
  .refine((v) => StrKey.isValidEd25519PublicKey(v), 'must be a G… Stellar public key');

const optionalContract = z
  .string()
  .default('')
  .refine((v) => v === '' || StrKey.isValidContract(v), 'must be a C… Stellar contract id');

const optionalAddress = z
  .string()
  .default('')
  .refine(
    (v) => v === '' || StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v),
    'must be a G… account or C… contract address',
  );

const commaList = (item: z.ZodType<string, string>, fallback = "") =>
  z
    .string()
    .default(fallback)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item));

const envSchema = z
  .object({
    DATABASE_URL: z.string({ error: 'is required' }).min(1, 'is required'),
    PORT: z.string().default('8000').transform(Number),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // ── HTTP ──────────────────────────────────────────────────────────────
    // Comma-separated origins allowed to call the API with credentials.
    CORS_ORIGINS: commaList(z.string().url(), 'http://localhost:3000'),

    // ── Auth ──────────────────────────────────────────────────────────────
    // Signs JWTs. Required in production; an ephemeral one is generated in
    // development/test so a fresh .env boots (sessions then end on restart).
    JWT_SECRET: optionalString,
    // Server key that signs SEP-10 challenge transactions. Not a funded
    // account and never the agent key. Same ephemeral fallback as above.
    AUTH_SIGNING_SECRET: optionalString,
    AUTH_HOME_DOMAIN: z.string().default('localhost'),
    AUTH_WEB_AUTH_DOMAIN: optionalString,
    // G… addresses allowed to call admin endpoints.
    ADMIN_ADDRESSES: commaList(stellarAccount),

    // ── Stellar ───────────────────────────────────────────────────────────
    STELLAR_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
    STELLAR_NETWORK_PASSPHRASE: z.string().default(Networks.TESTNET),
    MARKET_CORE_CONTRACT_ID: optionalContract,
    TREASURY_CONTRACT_ID: optionalContract,
    RESOLVER_CONTRACT_ID: optionalContract,
    REASONING_REGISTRY_CONTRACT_ID: optionalContract,
    USDC_CONTRACT_ID: optionalContract,
    // Where premium payments must be sent. Defaults to the treasury contract
    // (see docs/api.md: that makes subscription revenue trading capital).
    PAYMENTS_RECIPIENT: optionalAddress,
    DAILY_PASS_PRICE_RAW: z.string().regex(/^\d+$/, 'must be an integer in 7-decimal base units').default('5000000'),

    // dry-run: every write is built and simulated, never signed or sent.
    // live: writes are signed with AGENT_SECRET_KEY and submitted (testnet only).
    CHAIN_EXECUTION_MODE: z.enum(['dry-run', 'live']).default('dry-run'),
    AGENT_SECRET_KEY: optionalString,

    // Resolution spec committed at market creation (ADR 0001). Signer mode:
    // RESOLUTION_SIGNERS attest the outcome on the resolver contract. Empty
    // means the agent account is the only signer.
    RESOLUTION_SIGNERS: commaList(stellarAccount),
    RESOLUTION_THRESHOLD: z.string().default('1').transform(Number),
    RESOLUTION_DISPUTE_WINDOW_SECS: z.string().default('86400').transform(Number),

    INDEXER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    INDEXER_POLL_MS: z.string().default('5000').transform(Number),

    // ── LLM providers (optional; generation fails at runtime without one) ─
    ANTHROPIC_API_KEY: optionalString,
    GEMINI_API_KEY: optionalString,
    // OpenAI or any OpenAI-compatible endpoint (used by the router, #157).
    OPENAI_API_KEY: optionalString,
    OPENAI_BASE_URL: optionalString.refine(
      (v) => v === '' || /^https?:\/\//.test(v),
      'must be an http(s) URL',
    ),
    // JSON object keyed by LlmTask, or a path to a JSON file. Defaults to the
    // built-in policy that reproduces the pre-router behaviour.
    LLM_POLICY: optionalString,
    LLM_POLICY_FILE: optionalString,

    // ── IPFS ──────────────────────────────────────────────────────────────
    PINATA_API_KEY: optionalString,
    PINATA_SECRET_API_KEY: optionalString,
    IPFS_GATEWAY_URL: z.string().url().default('https://gateway.pinata.cloud/ipfs'),
    // Local verified content store (#100). Both are byte caps.
    IPFS_CACHE_MAX_OBJECT_BYTES: z.string().default('262144').transform(Number)
      .pipe(z.number().int().positive()),
    IPFS_CACHE_BUDGET_BYTES: z.string().default('268435456').transform(Number)
      .pipe(z.number().int().positive()),

    // ── Transparency reports (#159) ───────────────────────────────────────
    REPORTS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    REPORT_CRON: z.string().default('10 0 * * *'),
    REPORT_MODE: z.enum(['dry-run', 'live']).default('dry-run'),

    // ── Treasury admin console (#156) ─────────────────────────────────────
    // Lifetime of a prepared unsigned transaction.
    TREASURY_OP_TTL_SECONDS: z.string().default('3600').transform(Number)
      .pipe(z.number().int().positive()),
    // Optional stricter backend policy for withdraw operations.
    TREASURY_WITHDRAW_MIN_SIGNERS: z.string().default('0').transform(Number)
      .pipe(z.number().int().min(0).max(20)),

    // ── Data sources ──────────────────────────────────────────────────────
    NEWSAPI_KEY: optionalString,
    FRED_API_KEY: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'must be at least 32 characters' });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ['JWT_SECRET', 'AUTH_SIGNING_SECRET'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
      }
    }
    for (const key of ['AUTH_SIGNING_SECRET', 'AGENT_SECRET_KEY'] as const) {
      if (env[key] && !StrKey.isValidEd25519SecretSeed(env[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must be a Stellar secret seed (S…)' });
      }
    }
    if (env.CHAIN_EXECUTION_MODE === 'live') {
      if (!env.AGENT_SECRET_KEY) {
        ctx.addIssue({ code: 'custom', path: ['AGENT_SECRET_KEY'], message: 'is required when CHAIN_EXECUTION_MODE=live' });
      }
      if (env.STELLAR_NETWORK_PASSPHRASE !== Networks.TESTNET) {
        ctx.addIssue({
          code: 'custom',
          path: ['STELLAR_NETWORK_PASSPHRASE'],
          message: 'live mode is testnet-only; use the testnet passphrase',
        });
      }
    }
  });

export type Config = z.infer<typeof envSchema> & {
  /** Secrets generated for this process because they were not configured. */
  ephemeralSecrets: string[];
};

export class ConfigError extends Error {}

/** Parses an env object. Throws ConfigError naming every bad variable. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'} ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const data = parsed.data;
  const ephemeralSecrets: string[] = [];
  if (!data.JWT_SECRET) {
    data.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    ephemeralSecrets.push('JWT_SECRET');
  }
  if (!data.AUTH_SIGNING_SECRET) {
    data.AUTH_SIGNING_SECRET = Keypair.random().secret();
    ephemeralSecrets.push('AUTH_SIGNING_SECRET');
  }
  if (!data.AUTH_WEB_AUTH_DOMAIN) data.AUTH_WEB_AUTH_DOMAIN = data.AUTH_HOME_DOMAIN;
  return { ...data, ephemeralSecrets };
}

function loadOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

export const config = loadOrExit();
