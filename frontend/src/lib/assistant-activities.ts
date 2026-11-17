import "server-only";
import { getAdminDb } from "./firebase-admin";
import { kodlandDeliveryState } from "./kodland-task-progress";
import type { AssistantAskInput, AssistantSource } from "./assistant-contract";
import { AssistantError, assistantSafeText } from "./assistant-validation";

type Row = Record<string, unknown> & { id: string };
export type AssistantEvidence = {
  source: AssistantSource;
  data: Record<string, string>;
};
export type AssistantContext = { evidence: AssistantEvidence[]; limitations: string[] };
const MAX_ROWS = 100;
const MAX_EVIDENCE = 40;
const fields: Record<string, string[]> = {
  manual_classes: ["student_ids"],
  manual_students: [],
  manual_occurrences: ["class_id"],
  manual_activities: ["class_id", "student_id", "occurrence_id", "title", "status", "submission_text", "submission_url"],
  kodland_groups: ["external_id"],
  kodland_students: ["external_id", "external_class_id"],
  kodland_lessons: ["source_lesson_id", "external_class_id"],
  kodland_task_progress: ["external_class_id", "external_student_id", "lesson_id", "task_id", "task_title", "state"],
  kodland_reviews: ["external_class_id", "external_student_id", "lesson_id", "task_id", "task_title", "status_key"],
};

/** All reads are beneath the authenticated UID. Browser snapshots never enter this module. */
export async function readAssistantActivities(uid: string, input: AssistantAskInput): Promise<AssistantContext> {
  const db = getAdminDb();
  const policy = await db.collection("app_settings").doc("kodland_sync").get();
  const firebaseKodland = policy.data()?.storage === "firebase";
  const names = Object.keys(fields).filter(name => firebaseKodland || !name.startsWith("kodland_"));
  const limitations = ["Consulta limitada aos registros persistidos disponíveis no servidor. Identidades das fontes usam pseudônimos locais. Nomes digitados na pergunta livre podem permanecer no texto."];
  if (!firebaseKodland) limitations.push("As atividades Kodland estão no navegador e não estão disponíveis no servidor. Nenhum snapshot Kodland do Firestore foi usado.");
  const entries = await Promise.all(names.map(async name => {
    const snapshot = await db.collection("users").doc(uid).collection(name).select(...fields[name]).limit(MAX_ROWS + 1).get();
    if (snapshot.docs.length > MAX_ROWS) limitations.push(`A consulta de ${name} foi limitada a ${MAX_ROWS} registros. O resultado é parcial.`);
    return [name, snapshot.docs.slice(0, MAX_ROWS).map(doc => ({ ...doc.data(), id: doc.id }))] as const;
  }));
  const collections = Object.fromEntries(entries) as Record<string, Row[]>;
  return buildActivityContext(collections, input, limitations, firebaseKodland);
}

const matches = (filter: string | undefined, ...ids: unknown[]) => !filter || ids.includes(filter);
const string = (value: unknown) => typeof value === "string" ? value : "";

export function buildActivityContext(collections: Record<string, Row[]>, input: AssistantAskInput, limitations: string[], firebaseKodland: boolean): AssistantContext {
  const rows = (name: string) => collections[name] ?? [];
  const evidence: AssistantEvidence[] = [];
  const aliases = new Map<string, string>();
  const alias = (kind: string, id: unknown) => {
    const key = `${kind}:${id}`;
    if (!aliases.has(key)) aliases.set(key, `${kind}_${aliases.size + 1}`);
    return aliases.get(key)!;
  };
  const add = (row: Row, kind: string, group: string, student: string, lesson: string, state: string, title: unknown) => {
    if (evidence.length >= MAX_EVIDENCE) return;
    const ref = `activity_${evidence.length + 1}`;
    const label = assistantSafeText(title) || "Atividade";
    const groupAlias = alias("turma", group);
    const studentAlias = alias("aluno", student);
    const lessonAlias = alias("aula", lesson);
    evidence.push({
      source: { source: "activity", ref, label: `${label} · ${studentAlias} · ${lessonAlias} (${kind})`, href: "/classes?tab=activities" },
      data: { ref, origin: kind, group: groupAlias, student: studentAlias, lesson: lessonAlias, activity: alias("atividade", row.id), title: label, state },
    });
  };
  let authorizedFilter = false;
  for (const row of rows("manual_activities")) {
    const group = rows("manual_classes").find(group => group.id === row.class_id);
    const student = rows("manual_students").find(student => student.id === row.student_id);
    const lesson = rows("manual_occurrences").find(lesson => lesson.id === row.occurrence_id && lesson.class_id === row.class_id);
    if (!group || !student || !lesson || !Array.isArray(group.student_ids) || !group.student_ids.includes(student.id)) continue;
    if (!matches(input.group_id, group.id) || !matches(input.student_id, student.id)
      || !matches(input.lesson_id, lesson.id) || !matches(input.activity_id, row.id)) continue;
    authorizedFilter = true;
    // Pending in the existing manual workflow means awaiting correction only when a submission exists.
    const submitted = Boolean(string(row.submission_text).trim() || string(row.submission_url).trim());
    const state = row.status === "pending" ? (submitted ? "submitted" : "unknown")
      : ({ assigned: "assigned", submitted: "submitted", corrected: "corrected", completed: "delivered" }[string(row.status)] ?? "unknown");
    add(row, "manual", group.id, student.id, lesson.id, state, row.title);
  }
  if (firebaseKodland) {
    const seen = new Set<string>();
    const progressRows = rows("kodland_task_progress").map(row => ({ row, progress: true }));
    const reviews = rows("kodland_reviews").map(row => ({ row, progress: false }));
    const candidates = [...progressRows, ...reviews];
    const identity = (row: Row) => JSON.stringify([row.external_class_id, row.external_student_id, row.lesson_id, row.task_id]);
    // A legacy review filter must still use the current explicit progress for the same task.
    const selectedTasks = new Set(candidates.filter(({ row }) => matches(input.activity_id, row.id, row.task_id)).map(({ row }) => identity(row)));
    for (const { row, progress } of candidates) {
      const group = rows("kodland_groups").find(group => group.external_id === row.external_class_id);
      const student = rows("kodland_students").find(student => student.external_id === row.external_student_id && student.external_class_id === row.external_class_id);
      if (!group || !student || !string(row.lesson_id) || !string(row.task_id)) continue;
      const lesson = rows("kodland_lessons").find(lesson => lesson.external_class_id === row.external_class_id && matches(string(row.lesson_id), lesson.id, lesson.source_lesson_id));
      if (!matches(input.group_id, group.id, group.external_id) || !matches(input.student_id, student.id, student.external_id)
        || !matches(input.lesson_id, row.lesson_id, lesson?.id) || !selectedTasks.has(identity(row))) continue;
      authorizedFilter = true;
      const key = identity(row);
      if (seen.has(key)) continue;
      seen.add(key);
      const state = progress ? (["missing", "submitted", "corrected", "delivered", "not_graded", "unknown"].includes(string(row.state)) ? string(row.state) : "unknown") : kodlandDeliveryState(row.status_key);
      add(row, "kodland", group.id, student.id, string(row.lesson_id), state, row.task_title);
    }
  }
  if (evidence.length >= MAX_EVIDENCE) limitations.push("O contexto contém no máximo 40 atividades. A consulta pode ser parcial.");
  const hasFilter = Boolean(input.group_id || input.student_id || input.lesson_id || input.activity_id);
  if (hasFilter && !authorizedFilter && firebaseKodland) {
    throw new AssistantError(403, "context_not_authorized", "Os filtros não correspondem a atividades acessíveis nesta consulta.");
  }
  return { evidence, limitations };
}
