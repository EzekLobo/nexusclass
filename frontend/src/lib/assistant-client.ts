import type { AssistantAnswer, AssistantAskInput, AssistantSource } from "./assistant-contract";
import { getFirebaseAuth } from "./firebase";

const invalidAnswer = () => new Error("O assistente retornou uma resposta inválida. Tente novamente.");

/** Only destinations issued by our source catalog can become clickable citations. */
export function assistantSourceHref(source: AssistantSource): string | null {
  if (source.source === "activity" && source.href === "/classes?tab=activities") return source.href;
  if (source.source === "slack" && source.href === "/settings/slack") return source.href;
  return null;
}

export function parseAssistantAnswer(value: unknown, requestId: string): AssistantAnswer {
  if (!value || typeof value !== "object") throw invalidAnswer();
  const answer = value as AssistantAnswer;
  if (answer.request_id !== requestId || typeof answer.answer !== "string" || !answer.answer.trim()
    || answer.answer.length > 16000 || typeof answer.insufficient_context !== "boolean"
    || !Array.isArray(answer.sources) || answer.sources.length > 100
    || !Array.isArray(answer.limitations) || answer.limitations.length > 50
    || answer.limitations.some(item => typeof item !== "string" || item.length > 4000)) throw invalidAnswer();
  const refs = new Set<string>();
  for (const source of answer.sources) {
    if (!source || !["activity", "slack"].includes(source.source)
      || typeof source.ref !== "string" || !source.ref || source.ref.length > 200 || refs.has(source.ref)
      || typeof source.label !== "string" || !source.label.trim() || source.label.length > 1000
      || typeof source.href !== "string") throw invalidAnswer();
    refs.add(source.ref);
  }
  if (!answer.insufficient_context && !answer.sources.length) throw invalidAnswer();
  return answer;
}

export async function askAssistant(input: AssistantAskInput, signal: AbortSignal): Promise<AssistantAnswer> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) throw new Error("Sua sessão expirou. Entre novamente para perguntar ao assistente.");
  const token = await user.getIdToken();
  signal.throwIfAborted();
  if (auth.currentUser?.uid !== user.uid) throw new Error("A conta mudou. Abra novamente o assistente.");
  const response = await fetch("/api/assistant/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal,
    cache: "no-store",
  });
  if (auth.currentUser?.uid !== user.uid) throw new Error("A conta mudou. Abra novamente o assistente.");
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error.trim()) {
      throw new Error(body.error.slice(0, 1000));
    }
    const messages: Record<number, string> = {
      400: "Confira a pergunta e os filtros selecionados.",
      401: "Sua sessão expirou. Entre novamente para continuar.",
      403: "Os filtros ou fontes selecionados não estão disponíveis para sua conta. Revise a seleção.",
      413: "A pergunta excede o limite permitido. Reduza o texto.",
      429: "O limite de consultas foi atingido. Aguarde antes de tentar novamente.",
      503: "O assistente está indisponível. Tente novamente mais tarde.",
      504: "A consulta demorou além do esperado. Tente novamente.",
    };
    throw new Error(messages[response.status] ?? "Não foi possível consultar o assistente. Tente novamente.");
  }
  const value: unknown = await response.json();
  signal.throwIfAborted();
  if (auth.currentUser?.uid !== user.uid) throw new Error("A conta mudou. Abra novamente o assistente.");
  return parseAssistantAnswer(value, input.request_id);
}
