import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), reserve: vi.fn(), api: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/slack-server", async (importOriginal) => ({
  ...await importOriginal<typeof import("./slack-server")>(),
  loadSlackConnection: mocks.load, reserveSlackRead: mocks.reserve, slackApi: mocks.api,
  decryptSlackToken: () => "secret",
}));
import { readSlackContext, sanitizeSlackText } from "./slack-context";
import { SlackError } from "./slack-server";
const connection = () => ({ generation: "g1", workspace: { id: "T1" }, encryptedToken: "encrypted", selectedChannels: [{ id: "C1", name: "aulas" }] });
const timestamp = () => `${Math.floor(Date.now() / 1000) - 20}.000001`;
beforeEach(() => {
  vi.resetAllMocks(); mocks.load.mockResolvedValue(connection()); mocks.reserve.mockResolvedValue(undefined);
});
describe("Slack assistant context", () => {
  it("nega canal fora da seleção e limita janela antes de consultar", async () => {
    await expect(readSlackContext("alice", { conversationIds: ["C2"] })).rejects.toMatchObject({ status: 403 });
    await expect(readSlackContext("alice", { oldest: 0 })).rejects.toMatchObject({ status: 400 });
    expect(mocks.api).not.toHaveBeenCalled(); expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("seleção vazia não chama provedor", async () => {
    expect((await readSlackContext("alice", { conversationIds: [] })).evidence).toEqual([]);
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("pagina histórico e replies, deduplica raiz e minimiza campos", async () => {
    const ts = timestamp(); const replyTs = `${Number(ts) + 1}`;
    mocks.api.mockResolvedValueOnce({ messages: [{ ts, text: "atividade", user: "U1", reply_count: 1, files: ["secret"] }], response_metadata: { next_cursor: "page2" } });
    mocks.api.mockResolvedValueOnce({ messages: [{ ts, text: "atividade" }, { ts: replyTs, text: "entregue", user: "U2" }] });
    mocks.api.mockResolvedValueOnce({ messages: [] });
    const result = await readSlackContext("alice");
    expect(result.evidence).toHaveLength(2); expect(result.evidence[1]).toMatchObject({ thread_ts: ts, untrusted: true, text: "entregue" });
    expect(result.evidence[0]).not.toHaveProperty("files");
    expect(mocks.api.mock.calls.map((call) => call[0])).toEqual(["conversations.history", "conversations.replies", "conversations.history"]);
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
  it("preserva evidência da décima chamada e informa paginação parcial", async () => {
    let page = 0;
    mocks.api.mockImplementation(async () => {
      page += 1;
      return { messages: [{ ts: `${Math.floor(Date.now() / 1000) - 100 + page}.000001`, text: `página ${page}` }], response_metadata: { next_cursor: String(page) } };
    });
    const result = await readSlackContext("alice");
    expect(result.evidence).toHaveLength(10); expect(result.evidence.at(-1)?.text).toBe("página 10");
    expect(mocks.api).toHaveBeenCalledTimes(10); expect(result.limitations.join(" ")).toContain("interrompeu");
  });
  it("descarta contexto se canal foi desmarcado durante consulta", async () => {
    mocks.api.mockResolvedValueOnce({ messages: [{ ts: timestamp(), text: "private" }] });
    mocks.load.mockResolvedValueOnce(connection()).mockResolvedValueOnce({ ...connection(), selectedChannels: [] });
    await expect(readSlackContext("alice")).rejects.toMatchObject({ code: "slack_connection_changed" });
  });
  it("descarta contexto se conexão mudou durante consulta", async () => {
    mocks.api.mockResolvedValueOnce({ messages: [] });
    mocks.load.mockResolvedValueOnce(connection()).mockResolvedValueOnce({ ...connection(), generation: "g2" });
    await expect(readSlackContext("alice")).rejects.toMatchObject({ code: "slack_connection_changed" });
  });
  it("429 após página retorna conteúdo parcial com limitação explícita", async () => {
    mocks.api.mockResolvedValueOnce({ messages: [{ ts: timestamp(), text: "texto" }], response_metadata: { next_cursor: "next" } });
    mocks.api.mockRejectedValueOnce(new SlackError("slack_rate_limited", 429, 60));
    const result = await readSlackContext("alice");
    expect(result.evidence).toHaveLength(1); expect(result.limitations.join(" ")).toContain("slack_rate_limited");
  });
  it("falha de autorização após página não entrega contexto", async () => {
    mocks.api.mockResolvedValueOnce({ messages: [{ ts: timestamp(), text: "texto" }], response_metadata: { next_cursor: "next" } });
    mocks.api.mockRejectedValueOnce(new SlackError("slack_access_denied", 403));
    await expect(readSlackContext("alice")).rejects.toMatchObject({ status: 403 });
  });
  it("remove contatos, links e credenciais inclusive auth AQ", () => {
    const value = sanitizeSlackText("ana@example.com +55 (11) 99999-8888 https://example.test/private <mailto:test@test.com> xoxp-secret AIza123456 auth=AQsecret password=123 token=abc");
    expect(value).not.toMatch(/ana@|99999|https:|xoxp-secret|AIza123456|AQsecret|password=123|token=abc/);
    expect(sanitizeSlackText("a".repeat(2000))).toHaveLength(1500);
  });
});
