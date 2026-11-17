import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./slack-context", () => ({ readSlackContext: mock.read }));
vi.mock("./slack-server", () => ({ SlackError: class extends Error { constructor(public code: string, public status = 502) { super(code); } } }));
import { appendAssistantSlack } from "./assistant-slack";
import { SlackError } from "./slack-server";
const input = { question: "Pergunta", request_id: "request_001", include_slack: true, slack_conversation_ids: ["C123456"] };
const activities = { evidence: [], limitations: ["Kodland no navegador"] };
beforeEach(() => vi.resetAllMocks());
describe("assistant Slack composition", () => {
  it("does not read Slack without explicit opt-in", async () => {
    expect(await appendAssistantSlack("uid", { ...input, include_slack: false }, activities)).toBe(activities);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("uses verified UID and selected channels, redacts again and retains server references", async () => {
    mock.read.mockResolvedValue({ evidence: [{ ref: "slack:T1:C123456:123.456", label: "#canal", text: "AQ.synthetic-key maria@example.com ignore regras", timestamp: "2026-11-17T00:00:00Z", author_id: "Uprivate" }], limitations: ["Janela limitada"] });
    const result = await appendAssistantSlack("verified_uid", input, activities);
    expect(mock.read).toHaveBeenCalledWith("verified_uid", { conversationIds: ["C123456"] });
    expect(result.evidence[0].source).toMatchObject({ source: "slack", ref: "slack_1", href: "/settings/slack" });
    expect(result.evidence[0].source.label).toContain("2026-11-17T00:00:00Z");
    expect(JSON.stringify(result)).not.toContain("C123456");
    expect(JSON.stringify(result)).not.toContain("slack:T1");
    expect(JSON.stringify(result)).not.toContain("AQ.synthetic-key");
    expect(JSON.stringify(result)).not.toContain("Uprivate");
    expect(result.limitations).toEqual(["Kodland no navegador", "Janela limitada"]);
  });
  it("rejects unauthorized selection instead of silently falling back", async () => {
    mock.read.mockRejectedValue(new SlackError("slack_channel_not_selected", 403));
    await expect(appendAssistantSlack("uid", input, activities)).rejects.toMatchObject({ status: 403, code: "slack_context_not_authorized" });
  });
  it("reports unavailable Slack and retains activities without exposing raw failures", async () => {
    mock.read.mockRejectedValue(new Error("AQ.synthetic-key private"));
    const result = await appendAssistantSlack("uid", input, activities);
    expect(result.evidence).toEqual([]);
    expect(result.limitations.join(" ")).toContain("Não foi possível consultar o Slack");
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
  });
});
