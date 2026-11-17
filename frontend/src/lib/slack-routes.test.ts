import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), status: vi.fn(), start: vi.fn(), finish: vi.fn(), channels: vi.fn(), select: vi.fn(), disconnect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-auth", () => ({
  authenticatedUser: mocks.auth,
  RequestAuthError: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
vi.mock("@/lib/slack-server", async (original) => ({
  ...await original<typeof import("./slack-server")>(),
  slackStatus: mocks.status, beginSlackOAuth: mocks.start, finishSlackOAuth: mocks.finish,
  listSlackChannels: mocks.channels, selectSlackChannels: mocks.select, disconnectSlack: mocks.disconnect,
}));
import { GET, DELETE } from "@/app/api/integrations/slack/route";
import { POST } from "@/app/api/integrations/slack/start/route";
import { GET as callback } from "@/app/api/integrations/slack/callback/route";
import { GET as channels, PUT } from "@/app/api/integrations/slack/channels/route";
import { RequestAuthError } from "./server-auth";
import { SlackError, slackCookie } from "./slack-server";
beforeEach(() => {
  vi.resetAllMocks(); mocks.auth.mockResolvedValue({ uid: "alice" });
  vi.stubEnv("SLACK_CLIENT_ID", "client"); vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
  vi.stubEnv("SLACK_REDIRECT_URI", "https://example.test/api/integrations/slack/callback");
  vi.stubEnv("SLACK_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});
const req = (method = "GET", body?: unknown) => new Request("https://example.test/api/integrations/slack", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
describe("Slack HTTP boundary", () => {
  it("nega todas as rotas privadas antes de acessar integração", async () => {
    mocks.auth.mockRejectedValue(new RequestAuthError(401, "login"));
    for (const handler of [GET, DELETE, POST, channels, PUT]) expect((await handler(req())).status).toBe(401);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled();
  });
  it("inicia OAuth com cookie seguro e retorna somente URL", async () => {
    mocks.start.mockResolvedValue({ url: "https://slack.com/oauth/v2/authorize", browser: "nonce" });
    const response = await POST(req("POST"));
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600");
    expect(await response.json()).toEqual({ url: "https://slack.com/oauth/v2/authorize" });
    expect(mocks.start).toHaveBeenCalledWith("alice"); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("recusa mass assignment de UID e payload excessivo", async () => {
    expect((await PUT(req("PUT", { uid: "bob", channelIds: [] }))).status).toBe(400);
    expect((await PUT(req("PUT", { channelIds: [], extra: "a".repeat(3000) }))).status).toBe(413);
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it("usa UID autenticado na seleção", async () => {
    mocks.select.mockResolvedValue({ connected: true });
    expect((await PUT(req("PUT", { channelIds: ["C1"] }))).status).toBe(200);
    expect(mocks.select).toHaveBeenCalledWith("alice", ["C1"]);
  });
  it("propaga Retry-After sem detalhes do provedor", async () => {
    mocks.channels.mockRejectedValue(new SlackError("slack_rate_limited", 429, 120));
    const response = await channels(req()); expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
  });
  it("callback usa origem configurada e não reflete código ou erro", async () => {
    mocks.finish.mockRejectedValue(new Error("provider-secret"));
    const response = await callback(new Request("https://attacker.test/api/integrations/slack/callback?state=state&code=secret", { headers: { cookie: `${slackCookie}=browser` } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://example.test/settings/slack?slack=error");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await response.text()).toBe("");
  });
});
