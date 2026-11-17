import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase-admin", () => {
  const reference = (path: string) => ({ path, get: async () => ({ data: () => memory.get(path) }) });
  return { getAdminDb: () => ({
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`) }),
    runTransaction: async (action: (transaction: unknown) => unknown) => action({
      get: async (ref: { path: string }) => ({ data: () => memory.get(ref.path) }),
      set: (ref: { path: string }, value: Record<string, unknown>) => {
        const data = { ...value };
        if (data.expiresAt instanceof Date) { const time = data.expiresAt.getTime(); data.expiresAt = { toMillis: () => time }; }
        memory.set(ref.path, data);
      },
      update: (ref: { path: string }, value: Record<string, unknown>) => memory.set(ref.path, { ...memory.get(ref.path), ...value }),
      delete: (ref: { path: string }) => memory.delete(ref.path),
    }),
  }) };
});

import { beginSlackOAuth, decryptSlackToken, disconnectSlack, encryptSlackToken, finishSlackOAuth, listSlackChannels, reserveSlackRead, selectSlackChannels, slackApi, slackConfig, slackScopes, slackStatus } from "./slack-server";
const fetchMock = vi.fn();
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
beforeEach(() => {
  memory.clear(); vi.resetAllMocks(); vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SLACK_CLIENT_ID", "client"); vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
  vi.stubEnv("SLACK_REDIRECT_URI", "https://example.test/api/integrations/slack/callback");
  vi.stubEnv("SLACK_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});
function connect(uid = "alice") {
  memory.set(`private_slack_integrations/${uid}`, {
    connected: true, generation: "g1", workspace: { id: "T1", name: "Workspace" },
    encryptedToken: encryptSlackToken("xoxp-test-secret", uid, "T1"), scopes: slackScopes,
    selectedChannels: [{ id: "C1", name: "aula", private: false }],
  });
}
async function oauth() {
  const start = await beginSlackOAuth("alice");
  return { ...start, state: new URL(start.url).searchParams.get("state")! };
}
function grant() {
  fetchMock.mockResolvedValueOnce(reply({ ok: true, team: { id: "T1", name: "Escola" }, authed_user: { id: "U1", access_token: "xoxp-authorized", token_type: "user", scope: slackScopes.join(",") } }));
  fetchMock.mockResolvedValueOnce(reply({ ok: true, team_id: "T1", user_id: "U1" }));
}
describe("Slack server security", () => {
  it("cifra com IV aleatório e vincula ao UID/workspace", () => {
    const first = encryptSlackToken("token-secret", "alice", "T1");
    expect(first).not.toContain("token-secret");
    expect(encryptSlackToken("token-secret", "alice", "T1")).not.toBe(first);
    expect(decryptSlackToken(first, "alice", "T1")).toBe("token-secret");
    expect(() => decryptSlackToken(first, "bob", "T1")).toThrow();
    expect(() => decryptSlackToken(first, "alice", "T2")).toThrow();
    expect(() => decryptSlackToken(`${first.slice(0, -4)}AAAA`, "alice", "T1")).toThrow();
  });
  it("recusa callback HTTP e chave inválida", () => {
    vi.stubEnv("SLACK_REDIRECT_URI", "http://example.test/api/integrations/slack/callback");
    expect(slackConfig).toThrow();
    vi.stubEnv("SLACK_REDIRECT_URI", "https://example.test/api/integrations/slack/callback");
    vi.stubEnv("SLACK_TOKEN_ENCRYPTION_KEY", "short"); expect(slackConfig).toThrow();
  });
  it("solicita apenas user scopes e usa state aleatório sem UID", async () => {
    const start = await oauth(); const url = new URL(start.url);
    expect(url.searchParams.get("user_scope")?.split(",")).toEqual(slackScopes);
    expect(url.searchParams.has("scope")).toBe(false);
    expect(start.state).not.toContain("alice"); expect(start.state).not.toBe(start.browser);
    expect(JSON.stringify([...memory.values()])).not.toContain(start.browser);
  });
  it("state vinculado ao navegador, expirado e inválido não troca código", async () => {
    const start = await oauth();
    await expect(finishSlackOAuth(start.state, "A".repeat(43), "code")).rejects.toMatchObject({ code: "slack_invalid_state" });
    const pending = [...memory.entries()].find(([key]) => key.startsWith("private_slack_oauth/"))!;
    memory.set(pending[0], { ...pending[1], expiresAt: { toMillis: () => 1 } });
    await expect(finishSlackOAuth(start.state, start.browser, "code")).rejects.toMatchObject({ code: "slack_invalid_state" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("consome state uma vez, vincula UID e nunca expõe token em status", async () => {
    const start = await oauth(); grant();
    await finishSlackOAuth(start.state, start.browser, "code");
    const status = await slackStatus("alice");
    expect(status.connected).toBe(true); expect(status.workspace?.id).toBe("T1");
    expect(JSON.stringify(status)).not.toMatch(/xoxp|encryptedToken|authorized/);
    expect((await slackStatus("bob")).connected).toBe(false);
    await expect(finishSlackOAuth(start.state, start.browser, "code")).rejects.toMatchObject({ code: "slack_invalid_state" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("desconectar invalida callback em andamento", async () => {
    const start = await oauth(); await disconnectSlack("alice");
    await expect(finishSlackOAuth(start.state, start.browser, "code")).rejects.toMatchObject({ code: "slack_invalid_state" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("recusa escopo ausente e revoga token da instalação recusada", async () => {
    const start = await oauth();
    fetchMock.mockResolvedValueOnce(reply({ ok: true, team: { id: "T1" }, authed_user: { id: "U1", access_token: "bad", token_type: "user", scope: "channels:read" } }));
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    await expect(finishSlackOAuth(start.state, start.browser, "code")).rejects.toMatchObject({ code: "slack_invalid_installation" });
    expect((await slackStatus("alice")).connected).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toContain("auth.revoke");
  });
  it("recusa token rotativo sem persistir autorização incompleta", async () => {
    const start = await oauth();
    fetchMock.mockResolvedValueOnce(reply({ ok: true, team: { id: "T1" }, authed_user: { id: "U1", access_token: "rotating", token_type: "user", scope: slackScopes.join(","), expires_in: 3600 } }));
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    await expect(finishSlackOAuth(start.state, start.browser, "code")).rejects.toThrow();
    expect((await slackStatus("alice")).connected).toBe(false);
  });
  it("lista só canais participados e retorna cursor", async () => {
    connect(); fetchMock.mockResolvedValueOnce(reply({ ok: true, channels: [{ id: "C1", name: "a", is_member: true }, { id: "C2", name: "b", is_member: false }], response_metadata: { next_cursor: "next" } }));
    expect(await listSlackChannels("alice")).toEqual({ channels: [{ id: "C1", name: "a", private: false }], nextCursor: "next" });
  });
  it("seleção confirma membership no provedor e permite desmarcar todos", async () => {
    connect(); fetchMock.mockResolvedValueOnce(reply({ ok: true, channel: { id: "C2", name: "não participa", is_member: false } }));
    await expect(selectSlackChannels("alice", ["C2"])).rejects.toMatchObject({ code: "slack_access_denied" });
    expect((await selectSlackChannels("alice", [])).selectedChannels).toEqual([]);
    await expect(selectSlackChannels("alice", ["C1", "C1"])).rejects.toMatchObject({ status: 400 });
  });
  it("limita consultas por UID transacionalmente", async () => {
    connect(); await reserveSlackRead("alice", "g1");
    await expect(reserveSlackRead("alice", "g1")).rejects.toMatchObject({ status: 429 });
    await expect(reserveSlackRead("bob", "g1")).rejects.toMatchObject({ status: 409 });
  });
  it("bloqueia local antes da revogação e permite retry pendente", async () => {
    connect(); fetchMock.mockRejectedValueOnce(new Error("network secret"));
    expect(await disconnectSlack("alice")).toEqual({ disconnected: true, revocationPending: true });
    expect((await slackStatus("alice")).connected).toBe(false);
    await expect(beginSlackOAuth("alice")).rejects.toMatchObject({ code: "slack_disconnect_first" });
    fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    expect(await disconnectSlack("alice")).toEqual({ disconnected: true, revocationPending: false });
    expect(memory.get("private_slack_integrations/alice")).not.toHaveProperty("encryptedToken");
  });
  it("distingue 429, ok false, token revogado e timeout sem vazar erro bruto", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "120" } }));
    await expect(slackApi("conversations.history", "token")).rejects.toMatchObject({ code: "slack_rate_limited", retryAfter: 120 });
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: "token_revoked" }));
    await expect(slackApi("conversations.history", "token")).rejects.toMatchObject({ code: "slack_reconnect_required" });
    fetchMock.mockResolvedValueOnce(reply({ ok: false, error: "missing_scope" }));
    await expect(slackApi("conversations.history", "token")).rejects.toMatchObject({ code: "slack_access_denied" });
    fetchMock.mockRejectedValueOnce(new Error("raw secret"));
    await expect(slackApi("conversations.history", "token")).rejects.toMatchObject({ code: "slack_timeout", message: "slack_timeout" });
  });
});
