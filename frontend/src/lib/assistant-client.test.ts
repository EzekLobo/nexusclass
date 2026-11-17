import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantAnswer, AssistantAskInput } from "./assistant-contract";
import { askAssistant, assistantSourceHref, parseAssistantAnswer } from "./assistant-client";

const { auth, getIdToken } = vi.hoisted(() => {
  const getIdToken = vi.fn();
  return { auth: { currentUser: null as null | { uid: string; getIdToken: typeof getIdToken } }, getIdToken };
});
vi.mock("./firebase", () => ({ getFirebaseAuth: () => auth }));

const input: AssistantAskInput = { question: "Quais estão pendentes?", request_id: "request-12345", include_slack: true, group_id: "group1", student_id: "student1", lesson_id: "lesson1", activity_id: "activity1" };
const answer: AssistantAnswer = { request_id: input.request_id, answer: "A atividade está entregue.", insufficient_context: false, sources: [{ source: "activity", ref: "activity_1", label: "Atividade", href: "/classes?tab=activities" }], limitations: [] };

beforeEach(() => {
  getIdToken.mockResolvedValue("firebase-test-token");
  auth.currentUser = { uid: "owner", getIdToken };
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("assistant client", () => {
  it("envia token Firebase e somente o contrato de IDs ao endpoint próprio", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(answer));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await askAssistant(input, signal)).toEqual(answer);
    expect(fetch).toHaveBeenCalledWith("/api/assistant/ask", expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer firebase-test-token" }, body: JSON.stringify(input), signal, cache: "no-store" }));
  });

  it.each([401, 403, 409, 429, 503, 504])("mostra body.error no HTTP %s", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Serviço desabilitado pelo ambiente.", code: "assistant_disabled", request_id: input.request_id }, { status })));
    await expect(askAssistant(input, new AbortController().signal)).rejects.toThrow("Serviço desabilitado pelo ambiente.");
  });

  it("recusa sessão ausente sem consultar rede", async () => {
    auth.currentUser = null;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(askAssistant(input, new AbortController().signal)).rejects.toThrow("sessão expirou");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("descarta resposta após troca de UID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      auth.currentUser = { uid: "other", getIdToken };
      return Response.json(answer);
    }));
    await expect(askAssistant(input, new AbortController().signal)).rejects.toThrow("A conta mudou");
  });

  it("aborto durante token impede envio posterior", async () => {
    const controller = new AbortController();
    getIdToken.mockImplementationOnce(async () => { controller.abort(); return "token"; });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(askAssistant(input, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("valida request_id, fontes, duplicatas e insuficiência", () => {
    expect(parseAssistantAnswer(answer, input.request_id)).toEqual(answer);
    expect(() => parseAssistantAnswer(answer, "another-request")).toThrow("inválida");
    expect(() => parseAssistantAnswer({ ...answer, sources: [] }, input.request_id)).toThrow("inválida");
    expect(() => parseAssistantAnswer({ ...answer, sources: [answer.sources[0], answer.sources[0]] }, input.request_id)).toThrow("inválida");
    expect(() => parseAssistantAnswer({ ...answer, sources: [], insufficient_context: true }, input.request_id)).not.toThrow();
  });

  it("só oferece links internos do catálogo", () => {
    expect(assistantSourceHref(answer.sources[0])).toBe("/classes?tab=activities");
    for (const href of ["javascript:alert(1)", "//evil.test", "https://evil.test", "/classes?tab=activities&redirect=evil"]) {
      expect(assistantSourceHref({ ...answer.sources[0], href })).toBeNull();
    }
  });
});
