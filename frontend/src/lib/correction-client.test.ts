import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveCorrection, suggestCorrection, rubricError, safeCorrectionUrl, CorrectionRequestError } from "./correction-client";
import type { CorrectionSuggestInput, CorrectionSuggestion } from "./correction-contract";

const { auth, token } = vi.hoisted(() => { const token = vi.fn(); return { token, auth: { currentUser: null as null | { uid: string; getIdToken: typeof token } } }; });
vi.mock("./firebase", () => ({ getFirebaseAuth: () => auth }));
const { restoreCredentials } = vi.hoisted(() => ({ restoreCredentials: vi.fn() }));
vi.mock("./browser-credentials", () => ({ restoreKodlandCredentials: restoreCredentials }));
const input: CorrectionSuggestInput = { source: "manual", activity_id: "a1", expected_revision: "revision", request_id: "request-123" };
const answer: CorrectionSuggestion = { activity_id: "a1", source: "manual", request_id: input.request_id, suggestion_id: "s1", status: "draft_ready", score: 6, max_score: 10, precision: 1, criteria: [{ criterion_id: "c1", points: 6, justification: "Parcial", evidence_refs: ["submission_1"] }], feedback: "Confira o raciocínio.", strengths: [], corrections: [], limitations: [], model: "test", snapshot_hash: "hash", revision: "revision", context_provenance: "server", external_write_verified: false, created_at: "2026-11-17T12:00:00Z", expires_at: "2026-11-17T13:00:00Z" };
beforeEach(() => { token.mockResolvedValue("firebase-test-token"); auth.currentUser = { uid: "owner", getIdToken: token }; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("correction client", () => {
  it("recupera o cofre para geração Kodland e explica como recuperar acesso ausente", async () => {
    const kodland = { ...input, source: "kodland" as const };
    const selection = { taskId: "1", studentId: "2", groupId: "3", lessonId: "4" };
    const credentials = { username: "fixture", password: "synthetic-password" };
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...answer, source: "kodland", max_score: 50 }));
    vi.stubGlobal("fetch", fetch);
    restoreCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce(credentials);
    const signal = new AbortController().signal;
    await expect(suggestCorrection(kodland, signal, selection)).rejects.toThrow("Salve seu acesso Kodland em Configurações");
    expect(fetch).not.toHaveBeenCalled();
    expect((await suggestCorrection(kodland, signal, selection)).max_score).toBe(50);
    expect(fetch).toHaveBeenCalledWith("/api/assistant/corrections/kodland", expect.objectContaining({
      body: JSON.stringify({ input: kodland, access: { ...selection, ...credentials } }),
    }));
  });
  it("envia somente IDs/revisão manual com token e abort signal", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(answer)); vi.stubGlobal("fetch", fetch);
    expect(await suggestCorrection(input, new AbortController().signal)).toEqual(answer);
    expect(fetch).toHaveBeenCalledWith("/api/assistant/corrections/suggest", expect.objectContaining({ body: JSON.stringify(input), headers: { "Content-Type": "application/json", Authorization: "Bearer firebase-test-token" }, cache: "no-store" }));
  });
  it("preserva 429 e Retry-After para pausar a fila", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Quota" }, { status: 429, headers: { "Retry-After": "120" } })));
    await expect(suggestCorrection(input, new AbortController().signal)).rejects.toMatchObject({ status: 429, retryAfter: 120 });
  });
  it("recusa sessão ausente antes da rede", async () => {
    auth.currentUser = null; const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(suggestCorrection(input, new AbortController().signal)).rejects.toThrow("sessão expirou"); expect(fetch).not.toHaveBeenCalled();
  });
  it("troca de conta durante token impede envio", async () => {
    token.mockImplementationOnce(async () => { auth.currentUser = { uid: "other", getIdToken: token }; return "token"; });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(suggestCorrection(input, new AbortController().signal)).rejects.toThrow("A conta mudou"); expect(fetch).not.toHaveBeenCalled();
  });
  it("troca de conta durante leitura do body descarta a resposta", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => { auth.currentUser = { uid: "other", getIdToken: token }; return answer; } }));
    await expect(suggestCorrection(input, new AbortController().signal)).rejects.toThrow("A conta mudou");
  });
  it.each(["token", "body"])("limite de 55s inclui %s travado", async stage => {
    vi.useFakeTimers();
    const hanging = new Promise(() => {});
    if (stage === "token") token.mockReturnValueOnce(hanging);
    else vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => hanging }));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException("Timeout", "TimeoutError")), ms); return c.signal; });
    const promise = suggestCorrection(input, new AbortController().signal);
    const rejected = expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(55000); await rejected; timeout.mockRestore();
  });
  it("aborto enquanto token está pendente retorna e não envia depois", async () => {
    let resolveToken!: (value: string) => void; token.mockReturnValueOnce(new Promise<string>(resolve => { resolveToken = resolve; }));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const c = new AbortController();
    const pending = suggestCorrection(input, c.signal); c.abort(); await expect(pending).rejects.toThrow(); resolveToken("late"); await Promise.resolve(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ ...answer, score: 11 }, { ...answer, activity_id: "other" }, { ...answer, request_id: "other" }, { ...answer, criteria: null }])("recusa sugestão malformada", async value => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
    await expect(suggestCorrection(input, new AbortController().signal)).rejects.toThrow();
  });
  it("aprovação preserva pontos/feedback editados e nunca chama envio Kodland", async () => {
    const approval = { suggestion_id: "s1", snapshot_hash: "hash", score: 8.5, feedback: "Revisado pelo professor", request_id: "approved-123" };
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...approval, activity_id: "a1", status: "ready_to_send", external_write_verified: false })); vi.stubGlobal("fetch", fetch);
    expect((await approveCorrection(approval, new AbortController().signal)).status).toBe("ready_to_send"); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/assistant/corrections/approve", expect.objectContaining({ body: JSON.stringify(approval) }));
  });
  it("rubrica rejeita máximo divergente, precisão inválida e critérios ambíguos", () => {
    const rubric = { guidance: "Avaliar", precision: 1, max_score: 10, criteria: [{ id: "c1", description: "Correção", max_points: 10 }] };
    expect(rubricError(rubric)).toBe(""); expect(rubricError({ ...rubric, max_score: 9 })).not.toBe(""); expect(rubricError({ ...rubric, precision: 4 })).not.toBe(""); expect(rubricError({ ...rubric, criteria: [{ ...rubric.criteria[0], max_points: 10.01 }] })).not.toBe("");
  });
  it("links externos aceitam apenas hosts oficiais HTTPS", () => {
    expect(safeCorrectionUrl("https://learn.kodland.org/pt/task/1/check/2")).toBe("https://learn.kodland.org/pt/task/1/check/2");
    for (const url of ["javascript:alert(1)", "https://learn.kodland.org.evil.test", "https://user:password@bo.kodland.org", "http://bo.kodland.org", "//bo.kodland.org"]) expect(safeCorrectionUrl(url)).toBeNull();
    expect(new CorrectionRequestError("Quota", 429).status).toBe(429);
  });
});
