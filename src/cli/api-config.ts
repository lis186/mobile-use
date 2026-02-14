/**
 * AI provider configuration — shared between CLI and MCP server.
 */

const DEFAULT_MODEL_GOOGLE = 'gemini-2.5-flash';
const DEFAULT_MODEL_OPENAI = 'gpt-4o';

export function inferProvider(model: string): 'google' | 'openai' | null {
  if (/^(gpt-|o[1-9]|chatgpt-)/.test(model)) return 'openai';
  if (/^gemini-/.test(model)) return 'google';
  return null;
}

export function getApiConfig(model?: string): { apiKey: string; provider: 'google' | 'openai'; defaultModel: string } {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const inferred = model ? inferProvider(model) : null;
  if (inferred === 'openai' && openaiKey) {
    return { apiKey: openaiKey, provider: 'openai', defaultModel: model! };
  }
  if (inferred === 'google' && googleKey) {
    return { apiKey: googleKey, provider: 'google', defaultModel: model! };
  }

  if (googleKey) {
    return { apiKey: googleKey, provider: 'google', defaultModel: DEFAULT_MODEL_GOOGLE };
  }
  if (openaiKey) {
    return { apiKey: openaiKey, provider: 'openai', defaultModel: DEFAULT_MODEL_OPENAI };
  }

  throw new Error('No AI API key found. Set GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY.');
}
