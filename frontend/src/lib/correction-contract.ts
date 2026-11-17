/** Shared wire contract. No server imports: safe for the review UI. */
export type CorrectionCriterion = { id: string; description: string; max_points: number };
export type CorrectionRubric = {
  guidance: string;
  max_score: number;
  /** Decimal places, 0–3. Every criterion maximum must fit this precision. */
  precision: number;
  criteria: CorrectionCriterion[];
};
export type CorrectionManualContext = {
  provenance: "tutor_provided";
  statement: string;
  submission_text: string;
  submission_complete: boolean;
  rubric: CorrectionRubric;
  rubric_confirmed: true;
  delivery_state: "TASK_SUBMITTED" | "TASK_SUBMITTED_LATE";
  human_review_applicable: true;
  correction_url?: string;
};
export type CorrectionSuggestInput = {
  source: "manual" | "kodland";
  activity_id: string;
  request_id: string;
  /** Manual updated_at; Kodland tutor context revision, never an official revision. */
  expected_revision: string;
  manual_context?: CorrectionManualContext;
};
export type CorrectionCriterionResult = {
  criterion_id: string;
  points: number;
  justification: string;
  /** Exact server evidence IDs, e.g. submission_1. */
  evidence_refs: string[];
};
export type CorrectionStatus = "draft_ready" | "insufficient_context" | "stale" | "saved" | "ready_to_send" | "sending" | "sent" | "send_failed" | "send_unknown" | "send_partial" | "send_blocked";
export type CorrectionSuggestion = {
  suggestion_id: string;
  request_id: string;
  source: "manual" | "kodland";
  activity_id: string;
  status: CorrectionStatus;
  score: number | null;
  max_score: number | null;
  min_score?: number;
  precision: number | null;
  criteria: CorrectionCriterionResult[];
  strengths: string[];
  corrections: string[];
  feedback: string;
  limitations: string[];
  model: string | null;
  snapshot_hash: string;
  revision: string;
  context_provenance: "server" | "tutor_provided";
  external_write_verified: boolean;
  kodland_write_available?: boolean;
  correction_url?: string;
  created_at: string;
  expires_at: string;
};
export type CorrectionApproveInput = {
  suggestion_id: string;
  snapshot_hash: string;
  score: number;
  feedback: string;
  request_id: string;
};
export type CorrectionApproval = {
  suggestion_id: string;
  request_id: string;
  activity_id: string;
  status: "saved" | "ready_to_send" | "sending" | "sent" | "send_failed" | "send_unknown" | "send_partial" | "send_blocked";
  score: number;
  feedback: string;
  approved_at: string;
  external_write_verified: boolean;
  correction_url?: string;
};
export type CorrectionErrorResponse = { error: string; code: string; request_id?: string };
export const CORRECTION_BATCH_LIMIT = 5;
