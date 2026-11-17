import { describe, expect, it } from "vitest";
import { manualGradingFields, manualGradingForEdit, validateManualRubric } from "./manual-grading";

const rubric = { guidance: "Siga os critérios", max_score: 7.5, precision: 1, criteria: [{ id: "a", description: "Solução", max_points: 5 }, { id: "b", description: "Teste", max_points: 2.5 }] };
describe("manual grading preservation", () => {
  it("preserves an approved result and rubric in unrelated edits", () => {
    const previous = { grading_rubric: rubric, submission_complete: true, score: 5, max_score: 7.5, correction_origin: "assistant_approved" as const, correction_suggestion_id: "s", corrected_at: "2026-11-17" };
    expect(manualGradingFields({}, previous)).toEqual(previous);
    expect(manualGradingFields({ submission_complete: false }, previous).submission_complete).toBe(false);
  });
  it("validates task-specific fractional scales and criterion totals", () => {
    expect(validateManualRubric(rubric)).toEqual(rubric);
    expect(() => validateManualRubric({ ...rubric, max_score: 10 })).toThrow();
    expect(() => validateManualRubric({ ...rubric, precision: 0 })).toThrow();
    expect(() => validateManualRubric({ ...rubric, criteria: [rubric.criteria[0], rubric.criteria[0]] })).toThrow();
  });
  it("rejects invalid grades and omits absent Firestore fields", () => {
    expect(manualGradingFields({})).toEqual({});
    expect(() => manualGradingFields({ score: 11, max_score: 10 })).toThrow();
    expect(() => manualGradingFields({ score: NaN, max_score: 10 })).toThrow();
    expect(() => manualGradingFields({ grading_rubric: rubric, score: 7.55, max_score: 7.5 })).toThrow();
  });
  it("invalidates approved grades when the submission changes", () => {
    expect(manualGradingForEdit({ submission_text: "nova" }, { submission_text: "antiga", score: 5, max_score: 10, correction_origin: "assistant_approved" })).toEqual({});
  });
});
