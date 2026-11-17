import "server-only";
import { AssistantError } from "./assistant-validation";

function limit(name: string, fallback: number, maximum: number) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new AssistantError(503, "assistant_not_configured", "Revise a configuração do assistente no servidor.");
  }
  return value;
}

export function assistantConfig() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();
  if (process.env.GEMINI_ASSISTANT_ENABLED !== "true" || !apiKey || !model || !/^gemini-[a-z0-9.-]{1,80}$/.test(model)) {
    throw new AssistantError(503, "assistant_not_configured", "O assistente ainda não está configurado no servidor.");
  }
  return {
    apiKey, model,
    perMinute: limit("GEMINI_REQUESTS_PER_MINUTE", 2, 10),
    perDay: limit("GEMINI_REQUESTS_PER_DAY", 10, 100),
    globalPerDay: limit("GEMINI_GLOBAL_REQUESTS_PER_DAY", 50, 1000),
    maxOutputTokens: 1024,
    maxContextBytes: 20000,
    timeoutMs: 15000,
  };
}
export type AssistantConfig = ReturnType<typeof assistantConfig>;
