import { getFirebaseAuth } from "@/lib/firebase";
import type { SlackChannel, SlackStatus } from "@/lib/slack-contract";

export type SlackSettingsAdapter = {
  status(): Promise<SlackStatus>;
  channels(cursor?: string): Promise<{ channels: SlackChannel[]; nextCursor: string }>;
  select(channelIds: string[]): Promise<SlackStatus>;
  connect(): Promise<{ url: string }>;
  disconnect(): Promise<{ disconnected: boolean; revocationPending: boolean }>;
};

export function createSlackSettingsAdapter(ownerUid: string): SlackSettingsAdapter {
  async function request<T>(path = "", method = "GET", body?: unknown): Promise<T> {
    function assertOwner() {
      if (!ownerUid || getFirebaseAuth().currentUser?.uid !== ownerUid) throw new Error("Sua conta mudou. Recarregue esta página.");
    }
    assertOwner();
    const token = await getFirebaseAuth().currentUser!.getIdToken();
    assertOwner();
    const response = await fetch(`/api/integrations/slack${path}`, {
      method, cache: "no-store", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    const payload = await response.json();
    assertOwner();
    if (!response.ok) throw new Error(payload.message ?? "Não foi possível consultar o Slack.");
    return payload as T;
  }
  return {
    status: () => request(), channels: (cursor = "") => request(`/channels?cursor=${encodeURIComponent(cursor)}`),
    select: (channelIds) => request("/channels", "PUT", { channelIds }),
    connect: () => request("/start", "POST"), disconnect: () => request("", "DELETE"),
  };
}
