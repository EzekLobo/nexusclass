import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./kodland-correction-images", { spy: true });
import { downloadKodlandImage, matchesKodlandImage } from "./kodland-correction-images";
import { parseKodlandChat, parseKodlandCorrectionAccess, prepareKodlandCorrectionWrite, readKodlandCorrection, writeKodlandCorrection } from "./kodland-correction";
import { gradeCorrection } from "./correction-gemini";

const input = { source: "kodland" as const, activity_id: "selection", request_id: "synthetic", expected_revision: "kodland:3:4:1:2" };
const access = { taskId: "1", studentId: "2", groupId: "3", lessonId: "4", username: "fixture", password: "synthetic-password" };
const message = { id: 1, to_conversation: 7, from_who: 20, role: "student", is_deleted: false, message: "", is_file_image: true, file_storage: "https://media.example/a.png" };
const firstImage = { mimeType: "image/png", data: "aW1hZ2Ux" };
const secondImage = { mimeType: "image/jpeg", data: "aW1hZ2Uy" };
const config = { apiKey: "synthetic", model: "gemini-test", perMinute: 2, perDay: 10, globalPerDay: 50, timeoutMs: 1000, maxContextBytes: 20000, maxOutputTokens: 2048 };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("coleta Kodland para revisão", () => {
  it("usa a escala oficial e envia as duas imagens do aluno para o Gemini", async () => {
    const result = { insufficient_context: false, criteria: [{ criterion_id: "requisitos_do_enunciado", points: 40, justification: "A decoração aparece nas capturas.", evidence_refs: ["submission_1", "submission_2"] }], strengths: [], corrections: [], limitations: [], feedback: "Confira a decoração." };
    const backoffice = "https://backoffice.kodland.org/api/v2/";
    const answers: Record<string, unknown> = {
      "https://sso.production.kodland.org/login": { access_token: "synthetic-token" },
      [backoffice + "tasks/1/?group_id=3"]: { id: 1, kind: "CHAT", is_graded: true, min_grade: 10, max_grade: 50, unescaped_text_of_task: "<p>Decore o local &amp; anexe capturas.</p>", solution: "gabarito privado" },
      [backoffice + "students/2/get_progress_by_task/1/"]: { progress_id: 5, conversation_node: { conversation: 7 }, comment: "comentário privado" },
      [backoffice + "student_groups/3/lesson/4/get_group_progress/"]: { students_progress: [{ student_id: 2, tasks_data: [{ task_id: 1, task_status_key: "TASK_SUBMITTED" }] }] },
      [backoffice + "chat_messages/?to_conversation=7"]: [message, { ...message, id: 2, file_storage: "https://media.example/b.jpg" }, { ...message, role: "teacher", message: "mensagem do tutor" }],
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent": { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(result) }] } }] },
    };
    const task = answers[backoffice + "tasks/1/?group_id=3"] as { unescaped_text_of_task: string };
    task.unescaped_text_of_task += '<img src="https://media.example/statement.png">';
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      expect(answers[url]).toBeDefined();
      if (url.startsWith(backoffice)) expect(options).toMatchObject({ credentials: "omit", redirect: "error", headers: { authorization: "Bearer synthetic-token" } });
      return Response.json(answers[url]);
    });
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(downloadKodlandImage).mockResolvedValueOnce(firstImage).mockResolvedValueOnce(firstImage).mockResolvedValueOnce(secondImage);
    const context = await readKodlandCorrection(input, parseKodlandCorrectionAccess(access), new AbortController().signal);
    expect(context).toMatchObject({ statement: "Decore o local & anexe capturas.", minimum: 10, rubric: { max_score: 50 }, provenance: "server" });
    expect(JSON.stringify(context)).not.toMatch(/privado|mensagem do tutor|synthetic-token|synthetic-password|media\.example/);
    expect((await gradeCorrection(context, config)).score).toBe(40);
    const payload = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1].body));
    expect(payload.contents[0].parts.slice(1)).toEqual([{ inlineData: firstImage }, { inlineData: firstImage }, { inlineData: secondImage }]);
    expect(JSON.parse(payload.contents[0].parts[0].text).images).toEqual([
      { ref: "statement_image_1", purpose: "statement" },
      { ref: "submission_1", purpose: "submission" }, { ref: "submission_2", purpose: "submission" },
    ]);
  });

  it("rejeita conversa incompleta, autor ambíguo, anexo desconhecido e entrega só com link", () => {
    const failures = [
      { results: [message], next: "https://example.test" },
      [{ ...message, to_conversation: 8 }],
      [message, { ...message, id: 2, from_who: 21 }],
      [{ ...message, is_file_image: false }],
      [{ ...message, is_file_image: false, file_storage: null, message: "https://example.test/project" }],
      [{ ...message, role: "teacher" }, { ...message, is_deleted: true }],
    ];
    for (const rows of failures) expect(() => parseKodlandChat(rows, "7")).toThrow();
  });

  it("bloqueia host desconhecido, URL com credenciais e MIME incompatível", async () => {
    vi.stubEnv("KODLAND_CORRECTION_IMAGE_HOSTS", "media.example");
    for (const url of ["https://media.example.evil.test/a", "https://user:secret@media.example/a", "http://media.example/a"]) {
      await expect(downloadKodlandImage(url, new AbortController().signal)).rejects.toMatchObject({ code: "kodland_image_host" });
    }
    const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
    expect(matchesKodlandImage("image/png", png)).toBe(true);
    expect(matchesKodlandImage("image/jpeg", png)).toBe(false);
    expect(matchesKodlandImage("image/svg+xml", Buffer.from("<svg/>"))).toBe(false);
  });
});

describe("contrato de nota e feedback do Learn", () => {
  const target = { taskId: "1", studentId: "2", groupId: "3", lessonId: "4", progressId: "5", conversation: "7" };
  const feedback = "Bom trabalho.\nRevise o segundo passo.";
  const progress = { progress_id: 5, conversation_node: { conversation: 7 }, grade_datetime: "2026-11-17T12:01:00", grade: 42, comment: feedback };

  it("revalida o snapshot e bloqueia uma conversa alterada antes de escrever", async () => {
    const api = "https://backoffice.kodland.org/api/v2/";
    let conversation = 7;
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      expect(options.method).not.toBe("PUT");
      const answers: Record<string, unknown> = {
        "https://sso.production.kodland.org/login": { access_token: "fixture-token" },
        [api + "tasks/1/?group_id=3"]: { id: 1, kind: "CHAT", is_graded: true, min_grade: 0, max_grade: 50, unescaped_text_of_task: "Explique o resultado." },
        [api + "students/2/get_progress_by_task/1/"]: { progress_id: 5, conversation_node: { conversation } },
        [api + "student_groups/3/lesson/4/get_group_progress/"]: { students_progress: [{ student_id: 2, tasks_data: [{ task_id: 1, task_status_key: "TASK_SUBMITTED" }] }] },
        [api + `chat_messages/?to_conversation=${conversation}`]: [{ ...message, to_conversation: conversation, is_file_image: false, file_storage: "", message: "Texto igual nas duas conversas." }],
      };
      expect(answers[url]).toBeDefined();
      return Response.json(answers[url]);
    });
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const draft = await readKodlandCorrection(input, access, signal);
    expect(draft.kodlandTarget).toEqual(target);
    const credentials = { username: access.username, password: access.password };
    await expect(prepareKodlandCorrectionWrite(target, draft.snapshot_hash, credentials, signal)).resolves.toMatchObject({ token: "fixture-token" });
    conversation = 8;
    await expect(prepareKodlandCorrectionWrite(target, draft.snapshot_hash, credentials, signal)).rejects.toMatchObject({ code: "stale" });
  });

  it.each([
    { readBack: progress, status: "sent", putLost: false },
    { readBack: { ...progress, comment: { comment: feedback, datetime: progress.grade_datetime } }, status: "sent", putLost: true },
    { readBack: { ...progress, comment: "Outro texto" }, status: "send_partial", putLost: false },
    { readBack: { ...progress, grade: null }, status: "send_partial", putLost: false },
    { readBack: { ...progress, progress_id: 99 }, status: "send_unknown", putLost: false },
    { readBack: { ...progress, conversation_node: { conversation: 8 } }, status: "send_unknown", putLost: false },
    { readBack: { ...progress, grade_datetime: "2026-11-17T12:00:00" }, status: "send_unknown", putLost: false },
    { readBack: null, status: "send_unknown", putLost: true },
  ])("retorna $status conforme a releitura, inclusive com PUT perdido ($putLost)", async ({ readBack, status, putLost }) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        if (putLost) throw new Error("Conexão perdida");
        return new Response(null, { status: 204 });
      })
      .mockResolvedValueOnce(readBack ? Response.json(readBack) : new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(writeKodlandCorrection(target, "fixture-token", 42, feedback, "2026-11-17T12:00:00")).resolves.toBe(status);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://backoffice.kodland.org/api/v1/grade/5/", expect.objectContaining({
      method: "PUT", redirect: "error", credentials: "omit",
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      body: JSON.stringify({ grade: 42, comment: feedback }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://backoffice.kodland.org/api/v2/students/2/get_progress_by_task/1/", expect.objectContaining({
      headers: { authorization: "Bearer fixture-token" }, cache: "no-store",
    }));
  });
});
