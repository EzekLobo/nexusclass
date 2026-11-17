import "server-only";
import { randomUUID } from "node:crypto";
import { getAdminDb } from "./firebase-admin";
import type { CorrectionApproval, CorrectionApproveInput, CorrectionSuggestInput, CorrectionSuggestion } from "./correction-contract";
import { correctionHash, readCorrectionContext, type CorrectionContext } from "./correction-context";
import type { CorrectionGrade } from "./correction-gemini";
import { correctionError, scoreUnits } from "./correction-validation";

const TTL_MS = 30 * 86400000;
const records = () => getAdminDb().collection("private_correction_suggestions");
const ownerRef = (uid: string) => getAdminDb().collection("private_correction_owners").doc(correctionHash(uid));
const unavailable = () => correctionError(409, "reset_in_progress", "Os dados de correção estão sendo removidos. Tente novamente depois.");
const missing = () => correctionError(404, "suggestion_not_found", "Sugestão não encontrada ou expirada.");
type Stored = {
  uid: string; epoch: string; input_hash: string; nonce: string; processing: boolean; expires_at: Date;
  discarded?: boolean;
  suggestion?: CorrectionSuggestion; approval?: CorrectionApproval; approval_hash?: string;
};
function active(data: Stored | undefined, uid: string, epoch: string): asserts data is Stored {
  if (!data || data.uid !== uid || data.epoch !== epoch) throw missing();
  let expiration: number;
  try { expiration = data.expires_at instanceof Date ? data.expires_at.getTime() : (data.expires_at as unknown as { toMillis(): number }).toMillis(); }
  catch { throw missing(); }
  if (!Number.isFinite(expiration) || expiration <= Date.now() || data.discarded) throw missing();
}
export type CorrectionReservation = { id: string; epoch: string; input_hash: string; nonce: string; existing?: CorrectionSuggestion };

/** Capture before reading context so a reset during authorization also invalidates the request. */
export async function correctionGenerationEpoch(uid: string): Promise<string> {
  return getAdminDb().runTransaction(async tx => {
    const owner = await tx.get(ownerRef(uid));
    if (owner.data()?.resetting) throw unavailable();
    const epoch = String(owner.data()?.epoch ?? randomUUID());
    if (!owner.exists) tx.create(ownerRef(uid), { epoch, resetting: false });
    return epoch;
  });
}

/** Read-only replay precheck. Never reserve quota twice for a completed request. */
export async function replayCorrectionSuggestion(uid: string, input: CorrectionSuggestInput, epoch: string): Promise<CorrectionSuggestion | undefined> {
  return getAdminDb().runTransaction(async tx => {
    const [owner, snapshot] = await tx.getAll(ownerRef(uid), records().doc(correctionHash([uid, input.request_id])));
    if (owner.data()?.resetting || owner.data()?.epoch !== epoch) throw unavailable();
    const data = snapshot.data() as Stored | undefined;
    if (!data) return undefined;
    active(data, uid, epoch);
    if (data.input_hash !== correctionHash(input)) throw correctionError(409, "idempotency_conflict", "O identificador já foi usado com outro contexto.");
    if (!data.suggestion) throw correctionError(409, "duplicate_request", "Esta geração já foi iniciada; não será repetida automaticamente.");
    return data.suggestion;
  });
}

export async function reserveCorrectionSuggestion(uid: string, input: CorrectionSuggestInput, expectedEpoch?: string): Promise<CorrectionReservation> {
  const id = correctionHash([uid, input.request_id]); const inputHash = correctionHash(input);
  return getAdminDb().runTransaction(async tx => {
    const [owner, previous] = await tx.getAll(ownerRef(uid), records().doc(id));
    if (owner.data()?.resetting) throw unavailable();
    const epoch = String(owner.data()?.epoch ?? randomUUID());
    if (expectedEpoch !== undefined && expectedEpoch !== epoch) throw unavailable();
    const data = previous.data() as Stored | undefined;
    if (data) {
      active(data, uid, epoch);
      if (data.input_hash !== inputHash) throw correctionError(409, "idempotency_conflict", "O identificador já foi usado com outro contexto.");
      if (data.suggestion) return { id, epoch, input_hash: inputHash, nonce: data.nonce, existing: data.suggestion };
      throw correctionError(409, "duplicate_request", "Esta geração já foi iniciada; não será repetida automaticamente.");
    }
    if (!owner.exists) tx.create(ownerRef(uid), { epoch, resetting: false });
    const nonce = randomUUID();
    tx.create(records().doc(id), { uid, epoch, input_hash: inputHash, nonce, processing: true, expires_at: new Date(Date.now() + TTL_MS) });
    return { id, epoch, input_hash: inputHash, nonce };
  });
}

export async function saveCorrectionSuggestion(uid: string, input: CorrectionSuggestInput, reservation: CorrectionReservation, context: CorrectionContext, grade: CorrectionGrade, model: string | null): Promise<CorrectionSuggestion> {
  const now = Date.now();
  const suggestion: CorrectionSuggestion = {
    suggestion_id: reservation.id, request_id: input.request_id, source: input.source, activity_id: input.activity_id,
    status: grade.insufficient_context ? "insufficient_context" : "draft_ready", score: grade.score,
    max_score: context.rubric?.max_score ?? null, precision: context.rubric?.precision ?? null,
    criteria: grade.criteria, strengths: grade.strengths, corrections: grade.corrections, feedback: grade.feedback,
    limitations: [...new Set([...context.limitations, ...grade.limitations])], model, snapshot_hash: context.snapshot_hash, revision: context.revision,
    context_provenance: input.source === "manual" ? "server" : "tutor_provided", external_write_verified: false,
    ...(context.correction_url ? { correction_url: context.correction_url } : {}),
    created_at: new Date(now).toISOString(), expires_at: new Date(now + TTL_MS).toISOString(),
  };
  await getAdminDb().runTransaction(async tx => {
    const [owner, previous] = await tx.getAll(ownerRef(uid), records().doc(reservation.id));
    const state = owner.data();
    if (state?.resetting || state?.epoch !== reservation.epoch) throw unavailable();
    const stored = previous.data() as Stored | undefined;
    active(stored, uid, reservation.epoch);
    if (!stored.processing || stored.nonce !== reservation.nonce || stored.input_hash !== reservation.input_hash
      || stored.input_hash !== correctionHash(input) || reservation.id !== correctionHash([uid, input.request_id])) {
      throw correctionError(409, "reservation_conflict", "A reserva não corresponde a esta geração.");
    }
    // Detect changes during the provider request before publishing a draft.
    if (input.source === "manual") {
      const current = await readCorrectionContext(uid, input, tx);
      if (current.snapshot_hash !== context.snapshot_hash) throw correctionError(409, "stale", "A entrega ou rubrica mudou durante a geração.");
    }
    tx.update(records().doc(reservation.id), { processing: false, suggestion });
  });
  return suggestion;
}

export async function getCorrectionSuggestion(uid: string, id: string): Promise<CorrectionSuggestion> {
  return getAdminDb().runTransaction(async tx => {
    const [owner, snapshot] = await tx.getAll(ownerRef(uid), records().doc(id));
    if (owner.data()?.resetting) throw unavailable();
    const data = snapshot.data() as Stored | undefined;
    active(data, uid, String(owner.data()?.epoch ?? ""));
    if (!data.suggestion) throw correctionError(409, "generation_incomplete", "A geração não foi concluída. Solicite uma nova geração explicitamente.");
    return data.suggestion;
  });
}

export async function approveCorrectionSuggestion(uid: string, input: CorrectionApproveInput): Promise<CorrectionApproval> {
  const outcome = await getAdminDb().runTransaction(async tx => {
    const ref = records().doc(input.suggestion_id);
    const [owner, snapshot] = await tx.getAll(ownerRef(uid), ref);
    if (owner.data()?.resetting) throw unavailable();
    const data = snapshot.data() as Stored | undefined;
    active(data, uid, String(owner.data()?.epoch ?? ""));
    const suggestion = data.suggestion;
    if (!suggestion) throw missing();
    if (suggestion.snapshot_hash !== input.snapshot_hash) throw correctionError(409, "stale", "A revisão da sugestão não corresponde.");
    const approvalHash = correctionHash({ snapshot_hash: input.snapshot_hash, score: input.score, feedback: input.feedback });
    if (data.approval) {
      if (data.approval_hash !== approvalHash) throw correctionError(409, "already_approved", "A sugestão já foi aprovada com outros valores.");
      return { approval: { ...data.approval, request_id: input.request_id } };
    }
    if (suggestion.status !== "draft_ready" || suggestion.score === null || suggestion.max_score === null || suggestion.precision === null) throw correctionError(409, "not_approvable", "A sugestão não está pronta para aprovação.");
    const units = scoreUnits(input.score, suggestion.precision);
    if (units === null || units > scoreUnits(suggestion.max_score, suggestion.precision)!) throw correctionError(400, "invalid_score", "Confira a nota, o máximo e a precisão da atividade.");
    if (suggestion.source === "manual") {
      let current: CorrectionContext;
      try { current = await readCorrectionContext(uid, { source: "manual", activity_id: suggestion.activity_id, request_id: input.request_id, expected_revision: suggestion.revision }, tx); }
      catch (error) {
        if ((error as { code?: string }).code === "stale") { tx.update(ref, { "suggestion.status": "stale" }); return { stale: true }; }
        throw error;
      }
      if (current.snapshot_hash !== suggestion.snapshot_hash || !current.eligible) {
        tx.update(ref, { "suggestion.status": "stale" }); return { stale: true };
      }
    }
    const approvedAt = new Date().toISOString();
    const approval: CorrectionApproval = { suggestion_id: input.suggestion_id, request_id: input.request_id,
      activity_id: suggestion.activity_id, status: suggestion.source === "manual" ? "saved" : "ready_to_send",
      score: input.score, feedback: input.feedback, approved_at: approvedAt, external_write_verified: false,
      ...(suggestion.correction_url ? { correction_url: suggestion.correction_url } : {}) };
    if (suggestion.source === "manual") tx.update(getAdminDb().collection("users").doc(uid).collection("manual_activities").doc(suggestion.activity_id), {
      score: input.score, max_score: suggestion.max_score, feedback: input.feedback, status: "corrected", updated_at: approvedAt,
      correction_origin: "assistant_approved", correction_suggestion_id: input.suggestion_id, corrected_at: approvedAt,
    });
    tx.update(ref, { approval, approval_hash: approvalHash, "suggestion.status": approval.status, "suggestion.score": input.score, "suggestion.feedback": input.feedback });
    return { approval };
  });
  if (!outcome.approval) throw correctionError(409, "stale", "A entrega, o vínculo ou a rubrica mudou. Solicite nova revisão.");
  return outcome.approval;
}

export async function discardCorrectionSuggestion(uid: string, id: string): Promise<void> {
  await getAdminDb().runTransaction(async tx => {
    const [owner, snapshot] = await tx.getAll(ownerRef(uid), records().doc(id));
    if (owner.data()?.resetting) throw unavailable();
    const data = snapshot.data() as Stored | undefined;
    active(data, uid, String(owner.data()?.epoch ?? ""));
    // Keep request identity and nonce until TTL: late provider completion can never recreate a discarded draft.
    tx.set(records().doc(id), { uid, epoch: data.epoch, nonce: data.nonce, input_hash: data.input_hash,
      processing: false, discarded: true, expires_at: data.expires_at });
  });
}

/** A failed cleanup stays locked. Retrying is safe. Never release another reset's epoch. */
export async function beginCorrectionReset(uid: string): Promise<string> {
  const epoch = randomUUID(); const owner = ownerRef(uid);
  await getAdminDb().runTransaction(async tx => { await tx.get(owner); tx.set(owner, { epoch, resetting: true }); });
  while (true) {
    const removed = await getAdminDb().runTransaction(async tx => {
      const state = await tx.get(owner);
      if (state.data()?.epoch !== epoch) throw unavailable();
      const batch = await tx.get(records().where("uid", "==", uid).limit(200));
      for (const item of batch.docs) tx.delete(item.ref);
      return batch.size;
    });
    if (!removed) break;
  }
  return epoch;
}

/** Only call after all account-data mutations have ended, including any failure cleanup. */
export async function finishCorrectionReset(uid: string, token: string): Promise<void> {
  await getAdminDb().runTransaction(async tx => {
    const owner = ownerRef(uid); const state = await tx.get(owner);
    if (!state.data()?.resetting || state.data()?.epoch !== token) throw unavailable();
    tx.update(owner, { resetting: false });
  });
}

/** Administrative deletion: leaves the UID blocked permanently. Reset callers use begin/finish. */
export async function deleteCorrectionSuggestions(uid: string): Promise<void> { await beginCorrectionReset(uid); }
export const cleanupCorrectionSuggestions = deleteCorrectionSuggestions;
