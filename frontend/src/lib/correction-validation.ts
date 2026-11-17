import "server-only";
import { AssistantError } from "./assistant-validation";
import type { CorrectionApproveInput, CorrectionManualContext, CorrectionRubric, CorrectionSuggestInput } from "./correction-contract";

export const correctionError = (status: number, code: string, message: string) => new AssistantError(status, code, message);
export const invalidCorrection = () => correctionError(400, "invalid_input", "Confira os campos da correção.");
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalidCorrection();
}
export function text(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.trim().length > 0);
}
export function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value); }
export function requestId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value); }
export function scoreUnits(value: unknown, precision: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const scaled = value * 10 ** precision;
  const rounded = Math.round(scaled);
  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) <= 1e-7 ? rounded : null;
}
export function validateCorrectionRubric(value: unknown): CorrectionRubric {
  closed(value, ["guidance", "max_score", "precision", "criteria"]);
  if (!text(value.guidance, 6000) || !Number.isInteger(value.precision) || Number(value.precision) < 0 || Number(value.precision) > 3
    || !Array.isArray(value.criteria) || !value.criteria.length || value.criteria.length > 20) throw invalidCorrection();
  const precision = value.precision as number;
  const maximum = scoreUnits(value.max_score, precision);
  if (!maximum || maximum > 1e9) throw invalidCorrection();
  const ids = new Set<string>();
  let sum = 0;
  for (const item of value.criteria) {
    closed(item, ["id", "description", "max_points"]);
    const units = scoreUnits(item.max_points, precision);
    if (!validId(item.id) || ids.has(item.id) || !text(item.description, 1200) || !units) throw invalidCorrection();
    ids.add(item.id); sum += units;
  }
  if (sum !== maximum) throw correctionError(400, "ambiguous_rubric", "A soma dos critérios deve corresponder ao máximo na precisão confirmada.");
  return value as CorrectionRubric;
}
export function correctionUrl(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!text(value, 2000)) throw invalidCorrection();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["bo.kodland.org", "learn.kodland.org"].includes(url.hostname) || url.port || url.username || url.password
      || (url.hostname === "learn.kodland.org" && !/^\/[a-z]{2}(?:-[A-Z]{2})?\/task\/[^/]+\/check(?:\/[^/]+)?\/?$/.test(url.pathname))) throw invalidCorrection();
    return url.href;
  } catch { throw invalidCorrection(); }
}
export function parseCorrectionSuggest(value: unknown): CorrectionSuggestInput {
  closed(value, ["source", "activity_id", "request_id", "expected_revision", "manual_context"]);
  if (!["manual", "kodland"].includes(String(value.source)) || !validId(value.activity_id) || !requestId(value.request_id) || !text(value.expected_revision, 160)) throw invalidCorrection();
  if (value.source === "manual" && value.manual_context !== undefined) throw invalidCorrection();
  if (value.manual_context !== undefined) {
    const ctx = value.manual_context;
    closed(ctx, ["provenance", "statement", "submission_text", "submission_complete", "rubric", "rubric_confirmed", "delivery_state", "human_review_applicable", "correction_url"]);
    if (value.source !== "kodland" || ctx.provenance !== "tutor_provided" || !text(ctx.statement, 20000, true) || !text(ctx.submission_text, 20000, true)
      || typeof ctx.submission_complete !== "boolean" || ctx.rubric_confirmed !== true || ctx.human_review_applicable !== true
      || !["TASK_SUBMITTED", "TASK_SUBMITTED_LATE"].includes(String(ctx.delivery_state))) throw invalidCorrection();
    const parsed = { ...ctx, rubric: validateCorrectionRubric(ctx.rubric), ...(ctx.correction_url !== undefined ? { correction_url: correctionUrl(ctx.correction_url) } : {}) };
    value = { ...value, manual_context: parsed as CorrectionManualContext };
  }
  return value as CorrectionSuggestInput;
}
export function parseCorrectionApprove(value: unknown): CorrectionApproveInput {
  closed(value, ["suggestion_id", "snapshot_hash", "score", "feedback", "request_id"]);
  if (!validId(value.suggestion_id) || typeof value.snapshot_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshot_hash)
    || typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || !text(value.feedback, 6000) || !requestId(value.request_id)) throw invalidCorrection();
  return value as CorrectionApproveInput;
}
/** No truncation: oversize input is rejected before context construction. */
export async function readCorrectionBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw invalidCorrection();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 40000) { await reader.cancel(); throw correctionError(413, "payload_too_large", "O contexto excede o limite permitido; não foi truncado."); }
      chunks.push(part.value);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw invalidCorrection(); }
  } finally { reader.releaseLock(); }
}
