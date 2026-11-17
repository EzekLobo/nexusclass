import type { CorrectionApproval, CorrectionApproveInput, CorrectionSuggestInput, CorrectionSuggestion, CorrectionRubric } from "./correction-contract";
import { getFirebaseAuth } from "./firebase";
import { validateManualRubric } from "./manual-grading";

export class CorrectionRequestError extends Error {
  constructor(message: string, public status: number, public retryAfter: number = 0) { super(message); }
}

export function rubricError(rubric: CorrectionRubric): string {
  try { validateManualRubric(rubric); return ""; }
  catch (reason) { return reason instanceof Error ? reason.message : "Confira a rubrica."; }
}

export function safeCorrectionUrl(value?: string): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password && !url.port && ["learn.kodland.org", "bo.kodland.org"].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

async function request<T>(action: "suggest" | "approve", input: CorrectionSuggestInput | CorrectionApproveInput, signal: AbortSignal): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(55000)]);
  const aborted = new Promise<never>((_, reject) => { deadline.addEventListener("abort", () => reject(deadline.reason), { once: true }); });
  return Promise.race([requestWithSignal<T>(action, input, deadline), aborted]);
}

async function requestWithSignal<T>(action: "suggest" | "approve", input: CorrectionSuggestInput | CorrectionApproveInput, signal: AbortSignal): Promise<T> {
  const auth = getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) throw new Error("Sua sessão expirou. Entre novamente.");
  const token = await user.getIdToken();
  signal.throwIfAborted();
  if (auth.currentUser?.uid !== user.uid) throw new Error("A conta mudou. Reabra as correções.");
  const response = await fetch(`/api/assistant/corrections/${action}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal, cache: "no-store" });
  const body = await response.json();
  signal.throwIfAborted();
  if (auth.currentUser?.uid !== user.uid) throw new Error("A conta mudou. Reabra as correções.");
  if (!response.ok) throw new CorrectionRequestError(typeof body?.error === "string" ? body.error.slice(0, 1000) : "Não foi possível concluir a correção.", response.status, Number(response.headers.get("Retry-After")) || 60);
  if (!body || body.request_id !== input.request_id || typeof body.activity_id !== "string") throw new Error("Resposta de correção inválida.");
  return body as T;
}

export async function suggestCorrection(input: CorrectionSuggestInput, signal: AbortSignal): Promise<CorrectionSuggestion> {
  const result = await request<CorrectionSuggestion>("suggest", input, signal);
  if (result.activity_id !== input.activity_id || result.source !== input.source || !["draft_ready", "insufficient_context", "stale"].includes(result.status) || !Array.isArray(result.criteria) || !Array.isArray(result.limitations) || typeof result.feedback !== "string" || !result.suggestion_id || !result.snapshot_hash) throw new Error("Sugestão inválida.");
  if (result.status === "draft_ready" && (!Number.isFinite(result.score) || !Number.isFinite(result.max_score) || !Number.isInteger(result.precision) || result.precision! < 0 || result.precision! > 3 || result.score! < 0 || result.score! > result.max_score! || result.criteria.some(c => !c || typeof c.criterion_id !== "string" || !Number.isFinite(c.points) || typeof c.justification !== "string"))) throw new Error("Pontuação da sugestão inválida.");
  return result;
}

export async function approveCorrection(input: CorrectionApproveInput, signal: AbortSignal): Promise<CorrectionApproval> {
  const result = await request<CorrectionApproval>("approve", input, signal);
  if (result.suggestion_id !== input.suggestion_id || !["saved", "ready_to_send"].includes(result.status) || result.score !== input.score || result.feedback !== input.feedback) throw new Error("Aprovação inválida. Confira a atividade antes de tentar novamente.");
  return result;
}
