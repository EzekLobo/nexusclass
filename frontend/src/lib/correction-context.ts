import "server-only";
import { createHash } from "node:crypto";
import type { Transaction } from "firebase-admin/firestore";
import { getAdminDb } from "./firebase-admin";
import { generateRecurringOccurrences } from "./teaching-finance";
import type { ManualClass } from "./manual-teaching";
import type { CorrectionRubric, CorrectionSuggestInput } from "./correction-contract";
import { correctionError, validId, validateCorrectionRubric } from "./correction-validation";

export const correctionHash = (value: unknown): string => {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
};
export type KodlandCorrectionTarget = {
  taskId: string; studentId: string; groupId: string; lessonId: string; progressId: string; conversation: string;
};
export type CorrectionContext = {
  kodlandTarget?: KodlandCorrectionTarget;
  kodlandGradedAt?: string;
  source: "manual" | "kodland";
  activity_id: string;
  revision: string;
  snapshot_hash: string;
  rubric: CorrectionRubric | null;
  evidence: { ref: string; text: string }[];
  images?: { ref: string; purpose: "statement" | "submission"; inlineData: { mimeType: string; data: string } }[];
  provenance?: "server";
  minimum?: number;
  statement: string;
  limitations: string[];
  eligible: boolean;
  correction_url?: string;
};
/** Preserve code and text structure; remove recognized contacts/secrets/URLs without slicing. */
export function correctionSafeText(value: string): string {
  return value.replace(/https?:\/\/\S+|www\.\S+/gi, "[link removido]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email removido]")
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, "[telefone removido]")
    .replace(/(?:AIza[\w-]{20,}|AQ\.[\w.-]+|xox[baprs]-[\w-]+|Bearer\s+\S+|-----BEGIN[\s\S]*?-----END[^\n]*-----)/gi, "[segredo removido]");
}
export function buildCorrectionContext(input: CorrectionSuggestInput, row?: Record<string, unknown>): CorrectionContext {
  const tutor = input.source === "kodland" ? input.manual_context : undefined;
  if (input.source === "manual" && !row) throw correctionError(404, "activity_not_found", "Atividade não encontrada.");
  const revision = row ? String(row.updated_at ?? "") : input.expected_revision;
  if (revision !== input.expected_revision) throw correctionError(409, "stale", "A atividade mudou. Reabra a revisão.");
  const statement = row ? String(row.description ?? "") : tutor?.statement ?? "";
  const submission = row ? String(row.submission_text ?? "") : tutor?.submission_text ?? "";
  const complete = row ? row.submission_complete === true : tutor?.submission_complete === true;
  const limitations: string[] = input.source === "kodland" ? ["Contexto fornecido pelo tutor; vínculo, entrega e revisão Kodland não foram verificados. Envio externo indisponível."] : [];
  const eligible = row ? ["submitted", "pending"].includes(String(row.status)) && Boolean(submission.trim() || String(row.submission_url ?? "").trim()) : Boolean(tutor);
  if (!eligible) limitations.push("A atividade não está elegível para avaliação.");
  if (!statement.trim()) limitations.push("Falta o enunciado da atividade.");
  if (!submission.trim()) limitations.push("Falta a entrega em texto/código acessível; links não são abertos.");
  if (!complete) limitations.push("Confirme que o texto/código representa a entrega completa. Mídias e projetos binários exigem revisão manual.");
  let rubric: CorrectionRubric | null = null;
  try { rubric = validateCorrectionRubric(row ? row.grading_rubric : tutor?.rubric); }
  catch { limitations.push("Falta uma rubrica estruturada confirmada com máximo, precisão e critérios sem ambiguidade."); }
  const rawSnapshot = { source: input.source, activity_id: input.activity_id, revision, statement, submission, complete,
    rubric: row?.grading_rubric ?? tutor?.rubric ?? null,
    status: row?.status ?? tutor?.delivery_state ?? null,
    class_id: row?.class_id ?? null, student_id: row?.student_id ?? null, occurrence_id: row?.occurrence_id ?? null,
    submission_url: row?.submission_url ?? null, tutor: tutor ?? null };
  if (Buffer.byteLength(JSON.stringify(rawSnapshot), "utf8") > 20000) throw correctionError(413, "context_too_large", "O contexto excede 20 KB. Nenhum trecho foi truncado.");
  const sanitizedRubric = rubric ? { ...rubric, guidance: correctionSafeText(rubric.guidance), criteria: rubric.criteria.map(c => ({ ...c, description: correctionSafeText(c.description) })) } : null;
  const evidence = submission.trim() ? [{ ref: "submission_1", text: correctionSafeText(submission) }] : [];
  const result = { source: input.source, activity_id: input.activity_id, revision, snapshot_hash: correctionHash(rawSnapshot), rubric: sanitizedRubric,
    statement: correctionSafeText(statement), evidence, limitations, eligible: eligible && Boolean(statement.trim() && submission.trim() && complete && rubric),
    ...(tutor?.correction_url ? { correction_url: tutor.correction_url } : {}) };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 20000) throw correctionError(413, "context_too_large", "O contexto excede 20 KB. Nenhum trecho foi truncado.");
  return result;
}

/** Resolve only UID-scoped records; read membership again inside approval's transaction. */
export async function readCorrectionContext(uid: string, input: CorrectionSuggestInput, transaction?: Transaction): Promise<CorrectionContext> {
  if (input.source === "kodland") return buildCorrectionContext(input);
  const user = getAdminDb().collection("users").doc(uid);
  const ref = user.collection("manual_activities").doc(input.activity_id);
  const snapshot = transaction ? await transaction.get(ref) : await ref.get();
  const row = snapshot.data();
  if (!row || !validId(row.class_id) || !validId(row.student_id) || !validId(row.occurrence_id)) throw correctionError(404, "activity_not_found", "Atividade não encontrada.");
  const refs = [user.collection("manual_classes").doc(row.class_id), user.collection("manual_students").doc(row.student_id), user.collection("manual_occurrences").doc(row.occurrence_id)];
  const [group, student, occurrence] = transaction ? await transaction.getAll(...refs) : await getAdminDb().getAll(...refs);
  const classroom = group.data();
  if (!classroom || !student.exists || !Array.isArray(classroom.student_ids) || !classroom.student_ids.includes(row.student_id)) throw correctionError(403, "context_not_authorized", "O aluno não está vinculado à turma.");
  let validOccurrence = occurrence.exists && occurrence.data()?.class_id === row.class_id;
  if (!occurrence.exists) {
    const date = row.occurrence_id.split(":").at(-1) ?? "";
    try { validOccurrence = generateRecurringOccurrences({ ...classroom, id: group.id } as ManualClass, date, date).some(item => item.id === row.occurrence_id); }
    catch { validOccurrence = false; }
  }
  if (!validOccurrence) throw correctionError(403, "context_not_authorized", "A aula não pertence à turma.");
  return buildCorrectionContext(input, row);
}
