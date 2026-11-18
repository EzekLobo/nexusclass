import { beforeEach, describe, expect, it, vi } from "vitest";
const verifyIdToken = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase-admin", () => ({ getAdminAuth: () => ({ verifyIdToken }) }));
import { assertSlackMonitorOwner, authenticatedUser } from "./server-auth";
beforeEach(() => vi.resetAllMocks());
describe("autenticação do servidor", () => {
  it("verifica a revogação de tokens e o bloqueio da conta", async () => {
    verifyIdToken.mockResolvedValue({ uid: "teacher" });
    await authenticatedUser(new Request("http://localhost", { headers: { authorization: "Bearer token" } }));
    expect(verifyIdToken).toHaveBeenCalledWith("token", true);
  });
  it("recusa tokens revogados", async () => {
    verifyIdToken.mockRejectedValue(new Error("auth/id-token-revoked"));
    await expect(authenticatedUser(new Request("http://localhost", { headers: { authorization: "Bearer token" } }))).rejects.toMatchObject({ status: 401 });
  });
  it("restringe o monitor Slack à conta proprietária", () => {
    expect(() => assertSlackMonitorOwner({ email: "ezeklobo.dev@gmail.com" } as Parameters<typeof assertSlackMonitorOwner>[0])).not.toThrow();
    expect(() => assertSlackMonitorOwner({ email: "other@example.com" } as Parameters<typeof assertSlackMonitorOwner>[0])).toThrowError("O monitor Slack está disponível apenas para a conta proprietária nesta versão.");
  });
});
