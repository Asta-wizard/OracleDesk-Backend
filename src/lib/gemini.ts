/**
 * Compatibility shim over the Gemini provider (#157).
 *
 * The routing, health and retry policy now live in src/lib/llm/router.ts. This
 * module is kept so existing imports (and the generated default client export)
 * continue to work.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { geminiProvider, isDailyQuotaError, parseRetryDelayMs } from './llm/providers/gemini';
import type { ModelSpec } from './llm/types';

export const GEMINI_MODEL = 'gemini-2.0-flash';
export { isDailyQuotaError, parseRetryDelayMs };

const spec = (maxTokens: number, temperature: number): ModelSpec => ({
  provider: 'gemini',
  model: GEMINI_MODEL,
  temperature,
  maxTokens,
  timeoutMs: 60_000,
});

export async function callGemini(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
): Promise<string> {
  const result = await geminiProvider.complete(spec(maxTokens, 0.3), {
    task: 'generic_text',
    system: systemPrompt,
    user: userPrompt,
    mode: 'text',
  });
  return result.text;
}

export async function callGeminiJSON(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
): Promise<string> {
  const result = await geminiProvider.complete(spec(maxTokens, 0.1), {
    task: 'generic_json',
    system: systemPrompt,
    user: userPrompt,
    mode: 'json',
  });
  return result.text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
export default genAI;
