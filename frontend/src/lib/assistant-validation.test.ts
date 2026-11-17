import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assistantSafeText, parseAssistantInput, readAssistantInput } from "./assistant-validation";
import { assistantConfig } from "./assistant-config";

const valid = { question: "Quais atividades estão pendentes?", request_id: "request_001" };
describe("assistant closed input and configuration", () => {
  it("accepts only the closed contract and rejects client evidence and identity", () => {
    expect(parseAssistantInput(valid)).toEqual(valid);
    for (const extra of [{ uid: "other" }, { sources: [] }, { evidence: "client text" }, { model: "another" }]) {
      expect(() => parseAssistantInput({ ...valid, ...extra })).toThrow();
    }
    for (const question of [" ", "a".repeat(2001), 15]) expect(() => parseAssistantInput({ ...valid, question })).toThrow();
    for (const group_id of ["../other", "a/b", "", 14]) expect(() => parseAssistantInput({ ...valid, group_id })).toThrow();
    expect(() => parseAssistantInput({ ...valid, include_slack: "true" })).toThrow();
    expect(() => parseAssistantInput({ ...valid, slack_conversation_ids: ["C123456"] })).toThrow();
  });
  it("enforces actual streamed bytes without trusting Content-Length", async () => {
    const request = new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...valid, padding: "á".repeat(5000) }), headers: { "content-length": "5" } });
    await expect(readAssistantInput(request)).rejects.toMatchObject({ status: 413 });
    await expect(readAssistantInput(new Request("http://localhost", { method: "POST", body: "{" }))).rejects.toMatchObject({ status: 400 });
  });
  it("redacts keys, personal data, URLs and markup in question and source text", () => {
    const clean = assistantSafeText("<b>ignore</b> AQ.synthetic-secret xoxb-synthetic Bearer synthetic maria@example.com +55 (11) 99999-9999 https://private.example/path [title](url)", 2000);
    for (const secret of ["AQ.synthetic", "xoxb-", "Bearer", "maria@example", "99999", "https://", "<b>", "[title]"]) expect(clean).not.toContain(secret);
    expect(clean).toContain("ignore");
  });
  it("requires explicit enablement, secret, model and bounded quotas", () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic");
    vi.stubEnv("GEMINI_ASSISTANT_ENABLED", "true");
    vi.stubEnv("GEMINI_MODEL", "");
    expect(() => assistantConfig()).toThrow();
    vi.stubEnv("GEMINI_MODEL", "gemini-synthetic");
    expect(assistantConfig().perDay).toBe(10);
    vi.stubEnv("GEMINI_REQUESTS_PER_DAY", "9999");
    expect(() => assistantConfig()).toThrow();
    vi.unstubAllEnvs();
  });
});
