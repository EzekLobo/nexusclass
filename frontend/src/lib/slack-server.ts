import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getAdminDb } from "@/lib/firebase-admin";
import { SLACK_CONTEXT_LIMITATION, type SlackChannel, type SlackStatus } from "@/lib/slack-contract";

export class SlackError extends Error {
  constructor(public readonly code: string, public readonly status = 502, public readonly retryAfter?: number) {
    super(code);
  }
}

export const slackScopes = ["channels:read", "groups:read", "channels:history", "groups:history"];
export const slackCookie = "__Host-nexus-slack-oauth";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const integration = (uid: string) => getAdminDb().collection("private_slack_integrations").doc(uid);

export function slackConfig() {
  const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: clientSecret, SLACK_REDIRECT_URI: redirectUri, SLACK_TOKEN_ENCRYPTION_KEY: encryptionKey } = process.env;
  if (!clientId || !clientSecret || !redirectUri || !encryptionKey) throw new SlackError("slack_not_configured", 503);
  let redirect: URL;
  try { redirect = new URL(redirectUri); } catch { throw new SlackError("slack_not_configured", 503); }
  if (redirect.protocol !== "https:" || redirect.pathname !== "/api/integrations/slack/callback" || redirect.search || redirect.hash || redirect.username || redirect.password) throw new SlackError("slack_not_configured", 503);
  const key = Buffer.from(encryptionKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encryptionKey) throw new SlackError("slack_not_configured", 503);
  return { clientId, clientSecret, redirectUri, key };
}

export function encryptSlackToken(token: string, uid: string, team: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", slackConfig().key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([uid, team])));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSlackToken(value: string, uid: string, team: string) {
  try {
    const [version, iv, tag, encrypted, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !encrypted || extra) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", slackConfig().key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(JSON.stringify([uid, team])));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } catch { throw new SlackError("slack_credentials_unavailable", 503); }
}

type SlackPayload = {
  ok: boolean; error?: string; access_token?: string; token_type?: string; scope?: string;
  expires_in?: number; refresh_token?: string;
  authed_user?: { id?: string; access_token?: string; scope?: string; token_type?: string; expires_in?: number; refresh_token?: string };
  team?: { id?: string; name?: string }; team_id?: string; user_id?: string;
  channels?: Array<{ id: string; name: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean }>;
  channel?: { id: string; name: string; is_private?: boolean; is_member?: boolean; is_archived?: boolean };
  messages?: Array<{ text?: string; ts?: string; thread_ts?: string; user?: string; reply_count?: number; subtype?: string }>;
  response_metadata?: { next_cursor?: string }; has_more?: boolean;
};

export async function slackApi(method: string, token: string | null, parameters: Record<string, string> = {}): Promise<SlackPayload> {
  let response: Response;
  try {
    const authorization = token ? `Bearer ${token}` : `Basic ${Buffer.from(`${slackConfig().clientId}:${slackConfig().clientSecret}`).toString("base64")}`;
    response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST", headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters), cache: "no-store", signal: AbortSignal.timeout(8000),
    });
  } catch { throw new SlackError("slack_timeout", 504); }
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    throw new SlackError("slack_rate_limited", 429, Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60);
  }
  if (!response.ok) throw new SlackError("slack_unavailable");
  let payload: SlackPayload;
  try { payload = await response.json() as SlackPayload; } catch { throw new SlackError("slack_invalid_response"); }
  if (!payload || payload.ok !== true) {
    const code = payload?.error;
    if (["invalid_auth", "token_revoked", "token_expired", "account_inactive"].includes(code ?? "")) throw new SlackError("slack_reconnect_required", 409);
    if (["missing_scope", "not_in_channel", "channel_not_found", "access_denied"].includes(code ?? "")) throw new SlackError("slack_access_denied", 403);
    throw new SlackError("slack_provider_error");
  }
  return payload;
}

type Connection = {
  generation: string; connected: boolean; workspace: { id: string; name: string };
  selectedChannels: SlackChannel[]; encryptedToken: string; scopes: string[];
  nextReadAt?: number; pendingState?: string;
};

export async function loadSlackConnection(uid: string): Promise<Connection> {
  const data = (await integration(uid).get()).data() as Connection | undefined;
  if (!data?.connected || !data.encryptedToken) throw new SlackError("slack_disconnected", 409);
  return data;
}

export async function slackStatus(uid: string): Promise<SlackStatus> {
  let configured = true;
  try { slackConfig(); } catch { configured = false; }
  const data = (await integration(uid).get()).data() as Connection | undefined;
  return { connected: !!data?.connected, configured, workspace: data?.connected ? data.workspace : null, selectedChannels: data?.connected ? data.selectedChannels : [], limitations: [SLACK_CONTEXT_LIMITATION] };
}

export async function beginSlackOAuth(uid: string) {
  const config = slackConfig();
  const state = randomBytes(32).toString("base64url");
  const browser = randomBytes(32).toString("base64url");
  const stateHash = digest(state);
  const reference = integration(uid);
  await getAdminDb().runTransaction(async (transaction) => {
    const current = (await transaction.get(reference)).data();
    if (current?.connected || current?.encryptedToken) throw new SlackError("slack_disconnect_first", 409);
    transaction.set(reference, { generation: stateHash, pendingState: stateHash, connected: false, selectedChannels: [] });
    transaction.set(getAdminDb().collection("private_slack_oauth").doc(stateHash), {
      uid, browserHash: digest(browser), expiresAt: new Date(Date.now() + 600000),
    });
  });
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({ client_id: config.clientId, user_scope: slackScopes.join(","), redirect_uri: config.redirectUri, state }).toString();
  return { url: url.toString(), browser };
}

export async function finishSlackOAuth(state: string, browser: string, code: string | null) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new SlackError("slack_invalid_state", 400);
  const stateHash = digest(state);
  const reference = getAdminDb().collection("private_slack_oauth").doc(stateHash);
  const uid = await getAdminDb().runTransaction(async (transaction) => {
    const pending = (await transaction.get(reference)).data();
    if (!pending || pending.browserHash !== digest(browser) || pending.expiresAt.toMillis() <= Date.now()) throw new SlackError("slack_invalid_state", 400);
    const current = (await transaction.get(integration(pending.uid))).data();
    if (current?.pendingState !== stateHash) throw new SlackError("slack_invalid_state", 400);
    transaction.delete(reference);
    transaction.update(integration(pending.uid), { pendingState: null });
    return pending.uid as string;
  });
  if (!code || code.length > 2048) throw new SlackError("slack_oauth_denied", 400);
  const payload = await slackApi("oauth.v2.access", null, { code, redirect_uri: slackConfig().redirectUri });
  const user = payload.authed_user;
  const token = user?.access_token;
  const team = payload.team;
  if (!token) throw new SlackError("slack_invalid_installation");
  try {
    const scopes = (user.scope ?? "").split(",");
    if (user.token_type !== "user" || !team?.id || !/^T[A-Z0-9]+$/.test(team.id) || !user.id || slackScopes.some((scope) => !scopes.includes(scope)) || user.expires_in || user.refresh_token) throw new SlackError("slack_invalid_installation");
    const identity = await slackApi("auth.test", token);
    if (identity.team_id !== team.id || identity.user_id !== user.id) throw new SlackError("slack_invalid_installation");
    const encryptedToken = encryptSlackToken(token, uid, team.id);
    await getAdminDb().runTransaction(async (transaction) => {
      const target = integration(uid);
      const current = (await transaction.get(target)).data();
      if (current?.generation !== stateHash || current?.connected) throw new SlackError("slack_invalid_state", 409);
      transaction.set(target, {
        connected: true, generation: randomBytes(16).toString("hex"), encryptedToken,
        workspace: { id: team.id, name: (team.name ?? "Slack").slice(0, 120) },
        selectedChannels: [], scopes, connectedAt: new Date(), nextReadAt: 0,
      });
    });
  } catch (error) {
    try { await slackApi("auth.revoke", token); } catch { /* Installation was never exposed to readers. */ }
    throw error;
  }
}

export async function listSlackChannels(uid: string, cursor = "") {
  if (cursor.length > 2048 || /[\r\n]/.test(cursor)) throw new SlackError("slack_invalid_input", 400);
  const connection = await loadSlackConnection(uid);
  const result = await slackApi("conversations.list", decryptSlackToken(connection.encryptedToken, uid, connection.workspace.id), {
    types: "public_channel,private_channel", exclude_archived: "true", limit: "100", cursor,
  });
  return {
    channels: (result.channels ?? []).filter((channel) => channel.is_member && !channel.is_archived).map((channel) => ({ id: channel.id, name: channel.name.slice(0, 120), private: !!channel.is_private })),
    nextCursor: result.response_metadata?.next_cursor ?? "",
  };
}

export function validateSlackChannelIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5 || value.some((id) => typeof id !== "string" || !/^[CG][A-Z0-9]{1,30}$/.test(id)) || new Set(value).size !== value.length) throw new SlackError("slack_invalid_channels", 400);
  return value;
}

export async function selectSlackChannels(uid: string, value: unknown) {
  const ids = validateSlackChannelIds(value);
  const connection = await loadSlackConnection(uid);
  const token = decryptSlackToken(connection.encryptedToken, uid, connection.workspace.id);
  const channels: SlackChannel[] = [];
  for (const id of ids) {
    const { channel } = await slackApi("conversations.info", token, { channel: id });
    if (!channel || channel.id !== id || !channel.is_member || channel.is_archived) throw new SlackError("slack_access_denied", 403);
    channels.push({ id, name: channel.name.slice(0, 120), private: !!channel.is_private });
  }
  await getAdminDb().runTransaction(async (transaction) => {
    const reference = integration(uid);
    const current = (await transaction.get(reference)).data();
    if (!current?.connected || current.generation !== connection.generation) throw new SlackError("slack_connection_changed", 409);
    transaction.update(reference, { selectedChannels: channels, generation: randomBytes(16).toString("hex") });
  });
  return slackStatus(uid);
}

export async function disconnectSlack(uid: string) {
  const reference = integration(uid);
  const saved = await getAdminDb().runTransaction(async (transaction) => {
    const current = (await transaction.get(reference)).data() as Connection | undefined;
    transaction.set(reference, { ...current, connected: false, pendingState: null, selectedChannels: [], generation: randomBytes(16).toString("hex") });
    return current;
  });
  if (!saved?.encryptedToken) return { disconnected: true, revocationPending: false };
  try {
    await slackApi("auth.revoke", decryptSlackToken(saved.encryptedToken, uid, saved.workspace.id));
  } catch (error) {
    if (!(error instanceof SlackError) || error.code !== "slack_reconnect_required") return { disconnected: true, revocationPending: true };
  }
  await getAdminDb().runTransaction(async (transaction) => {
    const current = (await transaction.get(reference)).data();
    if (!current?.connected && current?.encryptedToken === saved.encryptedToken) transaction.set(reference, { connected: false, selectedChannels: [], generation: randomBytes(16).toString("hex") });
  });
  return { disconnected: true, revocationPending: false };
}

export async function reserveSlackRead(uid: string, generation: string) {
  await getAdminDb().runTransaction(async (transaction) => {
    const reference = integration(uid);
    const current = (await transaction.get(reference)).data();
    if (!current?.connected || current.generation !== generation) throw new SlackError("slack_connection_changed", 409);
    if (current.nextReadAt > Date.now()) throw new SlackError("slack_rate_limited", 429, Math.ceil((current.nextReadAt - Date.now()) / 1000));
    transaction.update(reference, { nextReadAt: Date.now() + 65000 });
  });
}
