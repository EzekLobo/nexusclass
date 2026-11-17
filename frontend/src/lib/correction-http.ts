import "server-only";
import { NextResponse } from "next/server";
import { authenticatedUser, RequestAuthError } from "./server-auth";
import { AssistantError } from "./assistant-validation";
import { readCorrectionBody, parseCorrectionApprove, parseCorrectionSuggest, validId, invalidCorrection, closed } from "./correction-validation";
import { correctionConfig, gradeCorrection } from "./correction-gemini";
import { readCorrectionContext } from "./correction-context";
import { reserveAssistantUsage, finishAssistantUsage } from "./assistant-usage";
import { approveCorrectionSuggestion, beginCorrectionReset, finishCorrectionReset, correctionGenerationEpoch, replayCorrectionSuggestion, discardCorrectionSuggestion, getCorrectionSuggestion, reserveCorrectionSuggestion, saveCorrectionSuggestion } from "./correction-store";

const reply = (body: unknown, status = 200, retryAfter?: number) => NextResponse.json(body, { status,
  headers: { "cache-control": "no-store", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) } });
export async function correctionRoute(request: Request, action: "suggest" | "approve" | "get" | "discard" | "cleanup" | "finish_reset", id?: string) {
  const started = Date.now(); let requestId: string | undefined;
  let reservation: Awaited<ReturnType<typeof reserveAssistantUsage>> | undefined;
  try {
    const user = await authenticatedUser(request);
    if (action === "cleanup") return reply({ reset_token: await beginCorrectionReset(user.uid) });
    if (action === "finish_reset") {
      const body = await readCorrectionBody(request); closed(body, ["reset_token"]);
      if (typeof body.reset_token !== "string" || !/^[a-f0-9-]{36}$/.test(body.reset_token)) throw invalidCorrection();
      await finishCorrectionReset(user.uid, body.reset_token); return reply({ reset_finished: true });
    }
    if (action === "get" || action === "discard") {
      if (!validId(id)) throw invalidCorrection();
      if (action === "get") return reply(await getCorrectionSuggestion(user.uid, id));
      await discardCorrectionSuggestion(user.uid, id); return reply({ discarded: true });
    }
    const body = await readCorrectionBody(request);
    if (action === "approve") {
      const input = parseCorrectionApprove(body); requestId = input.request_id;
      // Verify a still-valid session immediately before the transaction.
      await authenticatedUser(request);
      return reply(await approveCorrectionSuggestion(user.uid, input));
    }
    const input = parseCorrectionSuggest(body); requestId = input.request_id;
    const config = correctionConfig();
    // Context authorization precedes reservation/provider; no caller-supplied manual rows.
    const epoch = await correctionGenerationEpoch(user.uid);
    const existing = await replayCorrectionSuggestion(user.uid, input, epoch);
    if (existing) return reply(existing);
    const context = await readCorrectionContext(user.uid, input);
    reservation = await reserveAssistantUsage(user.uid, `correction_${input.request_id}`, config);
    const draft = await reserveCorrectionSuggestion(user.uid, input, epoch);
    if (draft.existing) {
      try { await finishAssistantUsage(reservation, "success", 0, "duplicate_replay", started); } catch { /* replay remains safe */ }
      return reply(draft.existing);
    }
    const grade = await gradeCorrection(context, config);
    await authenticatedUser(request);
    const result = await saveCorrectionSuggestion(user.uid, input, draft, context, grade, context.eligible ? config.model : null);
    // Telemetry failure must never turn a committed result into a failed write.
    try { await finishAssistantUsage(reservation, "success", context.evidence.length, result.status, started); } catch { /* quota stays consumed */ }
    return reply(result);
  } catch (error) {
    const failure = error instanceof AssistantError ? error : error instanceof RequestAuthError
      ? new AssistantError(error.status, error.status === 401 ? "unauthenticated" : "auth_unavailable", "Não foi possível validar sua sessão.")
      : new AssistantError(503, "correction_unavailable", "A correção assistida está temporariamente indisponível.");
    if (reservation) try { await finishAssistantUsage(reservation, "error", 0, failure.code, started); } catch { /* no private text logs */ }
    return reply({ error: failure.message, code: failure.code, ...(requestId ? { request_id: requestId } : {}) }, failure.status, failure.retryAfter);
  }
}
