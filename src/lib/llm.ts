/**
 * LLM entry point (#157).
 *
 * All calls go through the provider-agnostic router. The default policy
 * reproduces the historical behaviour (Anthropic Claude first, Gemini
 * fallback) while allowing per-task policies via LLM_POLICY / LLM_POLICY_FILE.
 */
import { createRouter } from './llm/router';
import { policies } from './llm/policy';
import { anthropicProvider, geminiProvider, openaiProvider } from './llm/providers';
import type { LlmRequest, LlmResult, LlmTask } from './llm/types';

export const llmRouter = createRouter(policies, {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  openai: openaiProvider,
});

export type { LlmRequest, LlmResult, LlmTask };
export { LlmError } from './llm/types';

/** Complete a request and return the text plus provenance. */
export async function completeLLM(req: LlmRequest): Promise<LlmResult> {
  return llmRouter.complete(req);
}

/** Backwards-compatible JSON wrapper. Invalid JSON triggers provider failover. */
export async function callLLMJSON(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  task: LlmTask = 'generic_json',
): Promise<string> {
  const result = await completeLLM({
    task,
    system: systemPrompt,
    user: userPrompt,
    mode: 'json',
    maxTokens,
  });
  return result.text;
}

/** Backwards-compatible plain-text wrapper. Never requests a JSON MIME type. */
export async function callLLMText(
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 2048,
  task: LlmTask = 'generic_text',
): Promise<string> {
  const result = await completeLLM({
    task,
    system: systemPrompt,
    user: userPrompt,
    mode: 'text',
    maxTokens,
  });
  return result.text;
}
