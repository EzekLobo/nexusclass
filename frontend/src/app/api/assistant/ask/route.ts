import { NextResponse } from "next/server";
import { authenticatedUser, RequestAuthError } from "@/lib/server-auth";
import { assistantConfig } from "@/lib/assistant-config";
import { AssistantError, readAssistantInput } from "@/lib/assistant-validation";
import { readAssistantActivities } from "@/lib/assistant-activities";
import { askGemini, limitAssistantContext } from "@/lib/assistant-gemini";
import { finishAssistantUsage, reserveAssistantUsage } from "@/lib/assistant-usage";
import { appendAssistantSlack } from "@/lib/assistant-slack";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const started = Date.now();
  let requestId: string | undefined;
  let reservation: Awaited<ReturnType<typeof reserveAssistantUsage>> | undefined;
  let evidenceCount = 0;
  const reply = (body: object, status = 200, retryAfter?: number) => NextResponse.json(body, {
    status, headers: { "cache-control": "no-store", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) },
  });
  try {
    const user = await authenticatedUser(request);
    const input = await readAssistantInput(request);
    requestId = input.request_id;
    const config = assistantConfig();
    reservation = await reserveAssistantUsage(user.uid, input.request_id, config);
    const activities = await readAssistantActivities(user.uid, input);
    const context = limitAssistantContext(await appendAssistantSlack(user.uid, input, activities), config.maxContextBytes);
    evidenceCount = context.evidence.length;
    const answer = evidenceCount ? await askGemini(input, context, config) : {
      request_id: requestId,
      answer: "Não há evidências suficientes disponíveis no servidor para responder a esta pergunta.",
      insufficient_context: true,
      sources: [],
      limitations: context.limitations,
    };
    try { await finishAssistantUsage(reservation, "success", evidenceCount, evidenceCount ? "answered" : "insufficient_context", started); }
    catch { /* Telemetry failure must not discard a completed answer. */ }
    return reply(answer);
  } catch (error) {
    const failure = error instanceof AssistantError ? error
      : error instanceof RequestAuthError ? new AssistantError(error.status, error.status === 401 ? "unauthenticated" : "auth_unavailable", error.status === 401 ? "Faça login para continuar." : "A autenticação está indisponível.")
      : new AssistantError(503, "assistant_unavailable", "O assistente está temporariamente indisponível.");
    if (reservation) {
      try { await finishAssistantUsage(reservation, "error", evidenceCount, failure.code, started); }
      catch { /* Reservation remains consumed. Never log provider or database error text. */ }
    }
    return reply({ error: failure.message, code: failure.code, ...(requestId ? { request_id: requestId } : {}) }, failure.status, failure.retryAfter);
  }
}
