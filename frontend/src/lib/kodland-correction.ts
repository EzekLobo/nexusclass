import "server-only";
import type { CorrectionSuggestInput } from "./correction-contract";
import { correctionHash, correctionSafeText, type CorrectionContext, type KodlandCorrectionTarget } from "./correction-context";
import { correctionError, closed, invalidCorrection, record, scoreUnits, text } from "./correction-validation";
import { downloadKodlandImage } from "./kodland-correction-images";
import { KodlandLoginError, loginKodland } from "./kodland-sso";
import { AssistantError } from "./assistant-validation";

export const kodlandCorrectionWriteEnabled = () => process.env.KODLAND_CORRECTION_WRITE_ENABLED === "true";
const api = "https://backoffice.kodland.org/api/v2/";
const identifier = (value: unknown) => (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) && /^[1-9]\d{0,14}$/.test(String(value)) ? String(value) : "";
const schemaError = (message: string) => correctionError(422, "kodland_context", message);
const unavailable = () => correctionError(502, "kodland_unavailable", "A Kodland não retornou o contexto da correção. Tente novamente.");

export function parseKodlandCorrectionAccess(value: unknown) {
  closed(value, ["taskId", "studentId", "groupId", "lessonId", "username", "password"]);
  const { taskId, studentId, groupId, lessonId } = value;
  const credentials = parseKodlandCorrectionCredentials({ username: value.username, password: value.password });
  if (typeof taskId !== "string" || typeof studentId !== "string" || typeof groupId !== "string" || typeof lessonId !== "string" ||
    ![taskId, studentId, groupId, lessonId].every(identifier)) throw invalidCorrection();
  return { taskId, studentId, groupId, lessonId, ...credentials };
}

export function parseKodlandCorrectionCredentials(value: unknown) {
  closed(value, ["username", "password"]);
  const { username, password } = value;
  if (!text(username, 320) || !text(password, 1024)) throw invalidCorrection();
  return { username, password };
}

const decodeEntities = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, match => {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const entity = match.slice(1, -1).toLowerCase();
  if (!entity.startsWith("#")) return named[entity];
  const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
});
const cleanStatement = (html: string) => correctionSafeText(decodeEntities(html
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
  .replace(/<\/?(?:div|p|li|br|h[1-6])\b[^>]*>/gi, "\n")
  .replace(/<[^>]*>/g, ""))).trim();

export function parseKodlandChat(value: unknown, conversation: string) {
  if (!Array.isArray(value) || value.length > 200) throw schemaError("A Kodland retornou um formato de conversa não reconhecido ou mais de 200 mensagens.");
  const authors = new Set<string>();
  const ids = new Set<string>();
  const messages: { ref: string; text: string; image?: string }[] = [];
  for (const row of value) {
    if (!record(row) || identifier(row.to_conversation) !== conversation || typeof row.is_deleted !== "boolean" || typeof row.role !== "string") {
      throw schemaError("Não foi possível verificar o vínculo das mensagens com a entrega.");
    }
    if (row.is_deleted || row.role !== "student") continue;
    const author = identifier(row.from_who);
    const id = identifier(row.id);
    if (!author || !id || ids.has(id)) throw schemaError("A Kodland retornou mensagens sem identidade verificável.");
    ids.add(id);
    authors.add(author);
    if (row.message != null && !text(row.message, 16000, true)) throw schemaError("O texto da entrega é inválido ou excede o limite.");
    const imageFileName = typeof row.file_name === "string" && /\.(?:png|jpe?g)$/i.test(row.file_name);
    if (row.file_storage != null && row.file_storage !== "" && ((!imageFileName && row.is_file_image !== true) || !text(row.file_storage, 8000))) throw schemaError("A entrega contém um anexo que precisa de revisão na Kodland.");
    if (row.is_file_image === true && !row.file_storage) throw schemaError("A Kodland marcou uma imagem sem fornecer o anexo.");
    const message = typeof row.message === "string" ? cleanStatement(row.message) : "";
    if (message.replaceAll("[link removido]", "").trim() || row.file_storage) messages.push({ ref: `submission_${messages.length + 1}`, text: message, ...(typeof row.file_storage === "string" && row.file_storage ? { image: row.file_storage } : {}) });
  }
  if (authors.size !== 1 || !messages.length) throw schemaError("Não foi possível identificar uma entrega de um único aluno na conversa.");
  return messages;
}

async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw schemaError("A resposta da Kodland excede 1 MiB."); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { reader.releaseLock(); }
}

function gradingTimestamp(progress: Record<string, unknown>) {
  if (typeof progress.grade_datetime === "string" && progress.grade_datetime) return progress.grade_datetime;
  if (record(progress.comment) && typeof progress.comment.datetime === "string") return progress.comment.datetime;
}

export async function readKodlandCorrection(input: CorrectionSuggestInput, access: ReturnType<typeof parseKodlandCorrectionAccess>, requestSignal: AbortSignal, sessionToken?: string): Promise<CorrectionContext> {
  const { taskId, studentId, groupId, lessonId, username, password } = access;
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(19000)]);
  const authError = () => correctionError(403, "kodland_access", "A Kodland recusou o acesso. Confira a conta salva e a permissão para a turma em Configurações.");
  const checkStatus = (status: number) => {
    if ([400, 401, 403].includes(status)) throw authError();
    if (status === 404) throw correctionError(404, "kodland_missing", "A Kodland não encontrou a tarefa, entrega ou conversa selecionada.");
    if (status === 429) throw new AssistantError(429, "kodland_rate_limit", "A Kodland limitou as consultas. Tente novamente em um minuto.", 60);
    throw unavailable();
  };
  try {
    const token = sessionToken ?? await loginKodland(username, password, signal);
    const get = async (path: string) => {
      const response = await fetch(api + path, {
        headers: { authorization: `Bearer ${token}` }, credentials: "omit",
        redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]),
      });
      if (!response.ok) { await response.body?.cancel(); checkStatus(response.status); }
      return boundedJson(response);
    };
    const [task, progress, group] = await Promise.all([
      get(`tasks/${taskId}/?group_id=${groupId}`),
      get(`students/${studentId}/get_progress_by_task/${taskId}/`),
      get(`student_groups/${groupId}/lesson/${lessonId}/get_group_progress/`),
    ]);
    if (!record(group) || !Array.isArray(group.students_progress)) throw schemaError("Não foi possível confirmar o estado da entrega na turma.");
    const student = group.students_progress.find(row => record(row) && identifier(row.student_id) === studentId);
    const pending = record(student) && Array.isArray(student.tasks_data) && student.tasks_data.some(row =>
      record(row) && identifier(row.task_id) === taskId && ["TASK_SUBMITTED", "TASK_SUBMITTED_LATE"].includes(String(row.task_status_key)));
    if (!pending) throw correctionError(409, "kodland_not_pending", "A entrega não consta como pendente na Kodland. Atualize as correções e tente novamente.");

    if (!record(task) || identifier(task.id) !== taskId || task.kind !== "CHAT" || task.is_graded !== true) throw schemaError("A geração automática exige uma tarefa CHAT com nota.");
    if (!record(progress) || !identifier(progress.progress_id) || !record(progress.conversation_node)) throw schemaError("A Kodland não informou a conversa vinculada à entrega.");
    const conversation = identifier(progress.conversation_node.conversation);
    if (!conversation) throw schemaError("A Kodland não informou uma conversa válida para a entrega.");
    const maximum = task.max_grade;
    const minimum = task.min_grade ?? 0;
    const precision = [0, 1, 2, 3].find(p => scoreUnits(maximum, p) !== null && scoreUnits(minimum, p) !== null);
    if (typeof maximum !== "number" || typeof minimum !== "number" || maximum <= 0 || minimum > maximum || precision === undefined) throw schemaError("A Kodland não informou uma escala de nota válida.");
    if (!text(task.unescaped_text_of_task, 16000)) throw schemaError("A Kodland não retornou o enunciado da tarefa.");
    const html = task.unescaped_text_of_task;
    const statement = cleanStatement(html);
    if (!statement) throw schemaError("A tarefa não tem enunciado em texto para derivar critérios.");
    if (/<(?:iframe|video|audio|object|embed|source)\b/i.test(html)) throw schemaError("O enunciado contém mídia que precisa de revisão na Kodland.");
    const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)];
    const imageUrls = imageTags.map(([tag]) => tag.match(/\s+src\s*=\s*["']([^"']+)["']/i)?.[1]);
    if (imageUrls.some(url => !url)) throw schemaError("A Kodland não informou um endereço válido para a imagem do enunciado.");
    const statementImages = [...new Set(imageUrls.flatMap(url => url ? [decodeEntities(url)] : []))];
    // The authenticated task response already identifies the embedded images.
    // Downloads still require an explicitly allowed host and validated bytes.
    const chat = await get(`chat_messages/?to_conversation=${conversation}`);
    const messages = parseKodlandChat(chat, conversation);
    const sources = [
      ...statementImages.map((url, index) => ({ url, ref: `statement_image_${index + 1}`, purpose: "statement" as const })),
      ...messages.flatMap(message => message.image ? [{ url: message.image, ref: message.ref, purpose: "submission" as const }] : []),
    ];
    if (sources.length > 4) throw schemaError("A tarefa contém mais de quatro imagens e precisa de revisão na Kodland.");
    const images = await Promise.all(sources.map(async ({ url, ref, purpose }) => ({ ref, purpose, inlineData: await downloadKodlandImage(url, signal) })));
    const evidence = messages.map(message => ({ ref: message.ref, text: message.text }));
    const rubric = { max_score: maximum, precision, guidance: "Critério derivado do enunciado. Avalie cada requisito explícito e justifique o grau de atendimento ao conjunto.", criteria: [
      { id: "requisitos_do_enunciado", description: "Atendimento aos requisitos explícitos do enunciado", max_points: maximum },
    ] };
    const revision = String(progress.progress_id);
    const gradedAt = gradingTimestamp(progress);
    return {
      source: "kodland", activity_id: input.activity_id, revision, provenance: "server",
      ...(gradedAt ? { kodlandGradedAt: gradedAt } : {}),
      kodlandTarget: { taskId, studentId, groupId, lessonId, progressId: revision, conversation },
      snapshot_hash: correctionHash({ taskId, studentId, groupId, lessonId, revision, conversation, originalGrade: progress.grade, originalComment: progress.comment, gradedAt: progress.grade_datetime, statement, rubric, minimum, evidence, images }),
      statement, rubric, evidence, images, eligible: true, minimum,
      limitations: ["Critério derivado do enunciado. A escala de pontos vem da Kodland."],
      correction_url: `https://learn.kodland.org/pt/task/${taskId}/check/${studentId}`,
    };
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    if (error instanceof KodlandLoginError) checkStatus(error.status);
    if (signal.aborted || (error instanceof Error && error.name === "TimeoutError")) throw correctionError(504, "kodland_timeout", "A consulta à Kodland demorou demais. Tente novamente.");
    throw unavailable();
  }
}

export async function prepareKodlandCorrectionWrite(target: KodlandCorrectionTarget, snapshotHash: string,
  credentials: ReturnType<typeof parseKodlandCorrectionCredentials>, signal: AbortSignal) {
  const token = await loginKodland(credentials.username, credentials.password, signal);
  const context = await readKodlandCorrection({
    source: "kodland", activity_id: "", request_id: "", expected_revision: "",
  }, { ...target, ...credentials }, signal, token);
  if (context.snapshot_hash !== snapshotHash) throw correctionError(409, "stale", "A entrega mudou. Gere uma nova revisão.");
  return { token, previousGradedAt: context.kodlandGradedAt };
}

/** The Learn grading form uses a single PUT; only the subsequent progress read confirms both fields. */
export async function writeKodlandCorrection(target: KodlandCorrectionTarget, token: string, score: number, feedback: string, previousGradedAt?: string) {
  const options = { headers: { authorization: `Bearer ${token}` }, credentials: "omit", redirect: "error", cache: "no-store" } as const;
  try {
    const response = await fetch(`https://backoffice.kodland.org/api/v1/grade/${target.progressId}/`, {
      ...options, method: "PUT", headers: { ...options.headers, "content-type": "application/json" },
      body: JSON.stringify({ grade: score, comment: feedback }), signal: AbortSignal.timeout(7000),
    });
    await response.body?.cancel();
  } catch { /* A lost response can still accompany a committed change. Always read back. */ }

  try {
    const response = await fetch(api + `students/${target.studentId}/get_progress_by_task/${target.taskId}/`, {
      ...options, signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return "send_unknown" as const;
    }
    const progress = await boundedJson(response);
    if (!record(progress) || identifier(progress.progress_id) !== target.progressId ||
      !record(progress.conversation_node) || identifier(progress.conversation_node.conversation) !== target.conversation) return "send_unknown" as const;
    const gradedAt = gradingTimestamp(progress);
    if (!gradedAt || gradedAt === previousGradedAt) return "send_unknown" as const;
    const gradeMatches = progress.grade === score;
    const commentMatches = (record(progress.comment) ? progress.comment.comment : progress.comment) === feedback;
    if (gradeMatches && commentMatches) return "sent" as const;
    if (gradeMatches || commentMatches) return "send_partial" as const;
  } catch { /* A failed read-back leaves the result uncertain. */ }
  return "send_unknown" as const;
}
