import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ auth: vi.fn(), config: vi.fn(), reserve: vi.fn(), finish: vi.fn(), read: vi.fn(), ask: vi.fn() }));
vi.mock("@/lib/assistant-slack", () => ({ appendAssistantSlack: async (_uid: string, _input: unknown, context: unknown) => context }));
vi.mock("@/lib/server-auth", () => ({ authenticatedUser: mock.auth, RequestAuthError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/assistant-config", () => ({ assistantConfig: mock.config }));
vi.mock("@/lib/assistant-usage", () => ({ reserveAssistantUsage: mock.reserve, finishAssistantUsage: mock.finish }));
vi.mock("@/lib/assistant-activities", () => ({ readAssistantActivities: mock.read }));
vi.mock("@/lib/assistant-gemini", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/assistant-gemini")>(), askGemini: mock.ask }));
import { POST } from "./route";
import { RequestAuthError } from "@/lib/server-auth";
import { AssistantError } from "@/lib/assistant-validation";
const input = { question: "Pergunta privada", request_id: "request_001" };
const req = (value: unknown = input) => new Request("http://localhost/api/assistant/ask", { method: "POST", body: JSON.stringify(value) });
beforeEach(() => {
  vi.resetAllMocks();
  mock.auth.mockResolvedValue({ uid: "verified_uid" });
  mock.config.mockReturnValue({ model: "gemini-synthetic", maxContextBytes: 20000 });
  mock.reserve.mockResolvedValue({ path: "private/reservation" });
  mock.read.mockResolvedValue({ evidence: [], limitations: ["Dados Kodland no navegador indisponíveis no servidor."] });
  mock.finish.mockResolvedValue(undefined);
});
describe("authenticated assistant route", () => {
  it("preserves the answer when success telemetry fails", async () => {
    mock.finish.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ insufficient_context: true });
    expect(mock.finish).toHaveBeenCalledTimes(1);
  });
  it("authenticates before reading body and returns no-store errors", async () => {
    mock.auth.mockRejectedValueOnce(new RequestAuthError(401, "private auth details"));
    const response = await POST(req());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mock.reserve).not.toHaveBeenCalled();
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("rejects identity override, unknown data, oversized or invalid requests", async () => {
    for (const data of [{ ...input, uid: "other" }, { ...input, evidence: [] }, { ...input, question: " " }]) expect((await POST(req(data))).status).toBe(400);
    expect((await POST(req({ ...input, padding: "x".repeat(9000) }))).status).toBe(413);
    expect(mock.reserve).not.toHaveBeenCalled();
  });
  it("returns honest insufficiency without Gemini and uses verified UID only", async () => {
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ insufficient_context: true, sources: [], request_id: input.request_id });
    expect(mock.reserve).toHaveBeenCalledWith("verified_uid", input.request_id, expect.any(Object));
    expect(mock.read).toHaveBeenCalledWith("verified_uid", input);
    expect(mock.ask).not.toHaveBeenCalled();
  });
  it("applies persistent quotas before source/provider calls", async () => {
    mock.reserve.mockRejectedValueOnce(new AssistantError(429, "rate_limit", "Aguarde", 60));
    const response = await POST(req());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(mock.read).not.toHaveBeenCalled();
    expect(mock.ask).not.toHaveBeenCalled();
  });
  it("answers from the bounded server context and records success metadata", async () => {
    const source = { source: "activity", ref: "activity_1", label: "Atividade", href: "/classes?tab=activities" };
    mock.read.mockResolvedValueOnce({ evidence: [{ source, data: { state: "corrected" } }], limitations: [] });
    const answer = { request_id: input.request_id, answer: "A atividade está corrigida.", insufficient_context: false, sources: [source], limitations: [] };
    mock.ask.mockResolvedValueOnce(answer);
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(answer);
    expect(mock.ask).toHaveBeenCalledWith(input, expect.objectContaining({ evidence: [expect.objectContaining({ source })] }), expect.any(Object));
    expect(mock.finish).toHaveBeenCalledWith(expect.any(Object), "success", 1, "answered", expect.any(Number));
  });
  it("returns provider timeout without any partial answer or uncharged retry", async () => {
    mock.read.mockResolvedValueOnce({ evidence: [{ source: { source: "activity", ref: "activity_1" }, data: { state: "unknown" } }], limitations: [] });
    mock.ask.mockRejectedValueOnce(new AssistantError(504, "provider_timeout", "Tempo excedido"));
    const response = await POST(req());
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ code: "provider_timeout", error: "Tempo excedido", request_id: input.request_id });
    expect(mock.finish).toHaveBeenCalledWith(expect.any(Object), "error", 1, "provider_timeout", expect.any(Number));
    expect(mock.reserve).toHaveBeenCalledTimes(1);
  });
  it("normalizes infrastructure errors and keeps logs free of prompt and provider content", async () => {
    mock.read.mockRejectedValueOnce(new Error("AQ.synthetic-private-key Pergunta privada"));
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private");
    expect(JSON.stringify(mock.finish.mock.calls)).not.toContain(input.question);
    expect(mock.finish).toHaveBeenCalledWith(expect.any(Object), "error", 0, "assistant_unavailable", expect.any(Number));
  });
  it("fails closed on missing configuration and skips external AI for empty combined context", async () => {
    mock.config.mockImplementationOnce(() => { throw new AssistantError(503, "assistant_not_configured", "Configure"); });
    expect((await POST(req())).status).toBe(503);
    expect(mock.reserve).not.toHaveBeenCalled();
    const response = await POST(req({ ...input, include_slack: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ insufficient_context: true });
    expect(mock.ask).not.toHaveBeenCalled();
  });
});
