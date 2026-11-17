import { beforeEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ currentUser: null as null | { uid: string; getIdToken: () => Promise<string> } }));
vi.mock("@/lib/firebase", () => ({ getFirebaseAuth: () => auth }));
import { createSlackSettingsAdapter } from "./slack-client";
const fetchMock = vi.fn();
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", fetchMock); auth.currentUser = { uid: "alice", getIdToken: async () => "alice-token" }; });
it("não usa sessão B para mutação cujo proprietário é A", async () => {
  const adapter = createSlackSettingsAdapter("alice");
  auth.currentUser = { uid: "bob", getIdToken: async () => "bob-token" };
  await expect(adapter.disconnect()).rejects.toThrow("conta mudou");
  await expect(adapter.select(["C1"])).rejects.toThrow("conta mudou");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("revalida UID após getIdToken antes de emitir mutação", async () => {
  let resolveToken!: (token: string) => void;
  auth.currentUser = { uid: "alice", getIdToken: () => new Promise((resolve) => { resolveToken = resolve; }) };
  const pending = createSlackSettingsAdapter("alice").disconnect();
  auth.currentUser = { uid: "bob", getIdToken: async () => "bob-token" };
  resolveToken("alice-token");
  await expect(pending).rejects.toThrow("conta mudou"); expect(fetchMock).not.toHaveBeenCalled();
});
it("descarta resposta da conta anterior após troca de sessão", async () => {
  fetchMock.mockImplementationOnce(async () => {
    auth.currentUser = { uid: "bob", getIdToken: async () => "bob-token" };
    return Response.json({ workspace: { name: "Alice" } });
  });
  await expect(createSlackSettingsAdapter("alice").status()).rejects.toThrow("conta mudou");
});
it("preserva token do proprietário e payload de seleção", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ connected: true }));
  await createSlackSettingsAdapter("alice").select(["C1"]);
  expect(fetchMock).toHaveBeenCalledWith("/api/integrations/slack/channels", expect.objectContaining({ method: "PUT", headers: { authorization: "Bearer alice-token", "content-type": "application/json" }, body: JSON.stringify({ channelIds: ["C1"] }) }));
});
