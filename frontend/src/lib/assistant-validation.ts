import "server-only";
import type { AssistantAskInput } from "./assistant-contract";

export class AssistantError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
    super(message);
  }
}

export const MAX_BODY_BYTES = 8192;
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const fields = new Set(["question", "request_id", "include_slack", "group_id", "student_id", "lesson_id", "activity_id", "slack_conversation_ids"]);

export function parseAssistantInput(value: unknown): AssistantAskInput {
  const invalid = () => new AssistantError(400, "invalid_input", "Confira a pergunta e os filtros do assistente.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.has(key))) throw invalid();
  if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 2000) throw invalid();
  if (typeof input.request_id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(input.request_id)) throw invalid();
  for (const key of ["group_id", "student_id", "lesson_id", "activity_id"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !idPattern.test(input[key] as string))) throw invalid();
  }
  if (input.include_slack !== undefined && typeof input.include_slack !== "boolean") throw invalid();
  if (input.slack_conversation_ids !== undefined) {
    if (!Array.isArray(input.slack_conversation_ids) || input.slack_conversation_ids.length > 5
      || input.slack_conversation_ids.some(id => typeof id !== "string" || !/^[CGD][A-Z0-9]{5,30}$/.test(id))
      || new Set(input.slack_conversation_ids).size !== input.slack_conversation_ids.length
      || !input.include_slack) throw invalid();
  }
  return { ...input, question: input.question.trim() } as AssistantAskInput;
}

/** Enforce the byte limit while streaming, including requests without Content-Length. */
export async function readAssistantInput(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AssistantError(400, "invalid_input", "Envie uma pergunta.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AssistantError(413, "payload_too_large", "A pergunta excede o limite permitido.");
      }
      chunks.push(chunk.value);
    }
    const body = Buffer.concat(chunks);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { throw new AssistantError(400, "invalid_input", "Envie JSON válido."); }
    return parseAssistantInput(value);
  } finally { reader.releaseLock(); }
}

/** Free text remains untrusted data even after removal of obvious PII and markup. */
export function assistantSafeText(value: unknown, max = 200) {
  if (typeof value !== "string") return "";
  return value.slice(0, 4000)
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link removido]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email removido]")
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, "[telefone removido]")
    .replace(/(?:AIza[\w-]{20,}|AQ\.[\w.-]+|xox[baprs]-[\w-]+|Bearer\s+\S+)/gi, "[segredo removido]")
    .replace(/[\u0000-\u001f\u007f<>\[\]`*_!#]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}
