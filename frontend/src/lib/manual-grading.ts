import type { ManualActivity } from "./manual-pedagogy";
import type { CorrectionRubric } from "./correction-contract";

export type ManualGradingFields = Pick<ManualActivity, "grading_rubric" | "submission_complete" | "score" | "max_score" | "correction_origin" | "correction_suggestion_id" | "corrected_at">;

export function validateManualRubric(value: CorrectionRubric): CorrectionRubric {
  if (!value || typeof value.guidance !== "string" || !value.guidance.trim() || value.guidance.length > 5000
    || !Number.isInteger(value.precision) || value.precision < 0 || value.precision > 3
    || !Number.isFinite(value.max_score) || value.max_score <= 0 || value.max_score > 100000
    || !Array.isArray(value.criteria) || !value.criteria.length || value.criteria.length > 20) throw new Error("Confira as orientações e os critérios de pontuação.");
  const factor = 10 ** value.precision;
  const exact = (n: number) => Math.abs(n * factor - Math.round(n * factor)) < 1e-7;
  const ids = new Set<string>();
  for (const c of value.criteria) {
    if (!c || typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id)
      || typeof c.description !== "string" || !c.description.trim() || c.description.length > 1000
      || !Number.isFinite(c.max_points) || c.max_points <= 0 || !exact(c.max_points)) throw new Error("Confira cada critério e sua pontuação.");
    ids.add(c.id);
  }
  if (!exact(value.max_score) || Math.round(value.criteria.reduce((sum, c) => sum + c.max_points, 0) * factor) !== Math.round(value.max_score * factor)) throw new Error("A soma dos critérios precisa corresponder à nota máxima.");
  return { guidance: value.guidance.trim(), max_score: value.max_score, precision: value.precision, criteria: value.criteria.map(c => ({ id: c.id, description: c.description.trim(), max_points: c.max_points })) };
}

/** Preserve approved grades during unrelated edits and omit undefined for Firestore. */
export function manualGradingFields(input: ManualGradingFields, previous: ManualGradingFields = {}): ManualGradingFields {
  const result: ManualGradingFields = {};
  const rubric = input.grading_rubric ?? previous.grading_rubric;
  if (rubric) result.grading_rubric = validateManualRubric(rubric);
  const complete = input.submission_complete ?? previous.submission_complete;
  if (complete !== undefined) {
    if (typeof complete !== "boolean") throw new Error("Confirme se a entrega está completa.");
    result.submission_complete = complete;
  }
  const score = input.score ?? previous.score;
  const maximum = input.max_score ?? previous.max_score;
  if (score !== undefined || maximum !== undefined) {
    if (typeof score !== "number" || typeof maximum !== "number" || !Number.isFinite(score) || !Number.isFinite(maximum) || score < 0 || maximum <= 0 || score > maximum) throw new Error("Nota inválida.");
    if (result.grading_rubric) {
      const factor = 10 ** result.grading_rubric.precision;
      if (maximum !== result.grading_rubric.max_score || Math.abs(score * factor - Math.round(score * factor)) >= 1e-7) throw new Error("A nota não respeita a precisão da rubrica.");
    }
    result.score = score; result.max_score = maximum;
  }
  for (const key of ["correction_origin", "correction_suggestion_id", "corrected_at"] as const) {
    const value = input[key] ?? previous[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 200 || (key === "correction_origin" && value !== "assistant_approved")) throw new Error("Registro de correção inválido.");
      Object.assign(result, { [key]: value });
    }
  }
  return result;
}

/** A changed submission or rubric cannot keep an old approved grade. */
export function manualGradingForEdit(input: ManualGradingFields & Partial<ManualActivity>, previous?: Partial<ManualActivity>): ManualGradingFields {
  const fields = manualGradingFields(input, previous);
  if (previous && ["description", "submission_text", "submission_url", "grading_rubric", "submission_complete"].some(key => {
    const k = key as keyof ManualActivity;
    return input[k] !== undefined && JSON.stringify(input[k]) !== JSON.stringify(previous[k]);
  })) {
    delete fields.score; delete fields.max_score; delete fields.correction_origin;
    delete fields.correction_suggestion_id; delete fields.corrected_at;
  }
  return fields;
}
