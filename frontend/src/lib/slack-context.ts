import "server-only";

import { SLACK_CONTEXT_LIMITATION, type SlackContext, type SlackContextInput, type SlackEvidence } from "@/lib/slack-contract";
import { decryptSlackToken, loadSlackConnection, reserveSlackRead, slackApi, SlackError, validateSlackChannelIds } from "@/lib/slack-server";

export function sanitizeSlackText(text: string) {
  return text
    .replace(/<[^>]+>/g, "[referência omitida]")
    .replace(/https?:\/\/\S+/gi, "[URL omitida]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[e-mail omitido]")
    .replace(/\b(?:xox[baprs]-[\w-]+|AIza[\w-]+|AQ[\w-]{20,}|Bearer\s+[\w.-]+)\b/gi, "[credencial omitida]")
    .replace(/(?:\+?\d[\d ()-]{8,}\d)/g, "[telefone omitido]")
    .replace(/\b(senha|password|(?:access[_ -]?)?token|auth(?:orization)?|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[omitido]")
    .slice(0, 1500);
}

/** UID must come from authenticatedUser, never from a request body. */
export async function readSlackContext(uid: string, input: SlackContextInput = {}): Promise<SlackContext> {
  const queriedAt = Date.now();
  const latest = input.latest ?? queriedAt / 1000;
  const oldest = input.oldest ?? latest - 7 * 86400;
  if (Object.keys(input).some((key) => !["conversationIds", "oldest", "latest"].includes(key)) || !Number.isFinite(oldest) || !Number.isFinite(latest) || oldest < 0 || latest > queriedAt / 1000 + 1 || oldest >= latest || latest - oldest > 30 * 86400) throw new SlackError("slack_invalid_window", 400);
  const connection = await loadSlackConnection(uid);
  const ids = input.conversationIds === undefined ? connection.selectedChannels.map((channel) => channel.id) : validateSlackChannelIds(input.conversationIds);
  if (ids.some((id) => !connection.selectedChannels.some((channel) => channel.id === id))) throw new SlackError("slack_channel_not_selected", 403);
  const context: SlackContext = { evidence: [], limitations: [SLACK_CONTEXT_LIMITATION], queried_at: new Date(queriedAt).toISOString() };
  if (!ids.length) {
    context.limitations.push("Nenhum canal foi selecionado para esta consulta.");
    return context;
  }
  await reserveSlackRead(uid, connection.generation);
  const token = decryptSlackToken(connection.encryptedToken, uid, connection.workspace.id);
  let calls = 0;
  let characters = 0;
  const seen = new Set<string>();
  const canAdd = () => context.evidence.length < 60 && characters < 18000;
  const canFetch = () => calls < 10 && canAdd() && Date.now() - queriedAt < 20000;
  function add(message: { text?: string; ts?: string; thread_ts?: string; user?: string }, channelId: string) {
    if (!message.ts || !/^\d+\.\d+$/.test(message.ts) || Number(message.ts) < oldest || Number(message.ts) > latest || !message.text || !canAdd()) return;
    const ref = `slack:${connection.workspace.id}:${channelId}:${message.ts}`;
    if (seen.has(ref)) return;
    seen.add(ref);
    const text = sanitizeSlackText(message.text).slice(0, 18000 - characters);
    characters += text.length;
    context.evidence.push({
      source: "slack", ref, label: `#${connection.selectedChannels.find((channel) => channel.id === channelId)?.name ?? channelId}`,
      text, channel_id: channelId, thread_ts: message.thread_ts ?? message.ts,
      timestamp: new Date(Number(message.ts) * 1000).toISOString(),
      author_id: /^[UW][A-Z0-9]+$/.test(message.user ?? "") ? message.user! : "unknown", untrusted: true,
    } satisfies SlackEvidence);
  }
  try {
    for (const channel of ids) {
      let cursor = "";
      do {
        if (!canFetch()) break;
        calls += 1;
        const page = await slackApi("conversations.history", token, { channel, oldest: String(oldest), latest: String(latest), inclusive: "true", limit: "15", cursor });
        for (const message of page.messages ?? []) add(message, channel);
        for (const root of page.messages ?? []) {
          if (!root.reply_count || !root.ts || !canFetch()) continue;
          let repliesCursor = "";
          do {
            if (!canFetch()) break;
            calls += 1;
            const replies = await slackApi("conversations.replies", token, { channel, ts: root.ts, oldest: String(oldest), latest: String(latest), inclusive: "true", limit: "15", cursor: repliesCursor });
            for (const message of replies.messages ?? []) add({ ...message, thread_ts: root.ts }, channel);
            const next = replies.response_metadata?.next_cursor ?? "";
            if (next && next === repliesCursor) throw new SlackError("slack_pagination_incomplete");
            repliesCursor = next;
            if (replies.has_more && !next) context.limitations.push("A paginação de uma thread ficou incompleta.");
          } while (repliesCursor);
          if (repliesCursor) context.limitations.push("Uma thread excedeu o limite desta consulta.");
        }
        const next = page.response_metadata?.next_cursor ?? "";
        if (next && next === cursor) throw new SlackError("slack_pagination_incomplete");
        cursor = next;
        if (page.has_more && !next) context.limitations.push("O histórico do canal ficou incompleto.");
      } while (cursor);
      if (!canFetch()) { context.limitations.push("O limite de volume ou tempo interrompeu a consulta. Há mensagens ou canais não consultados."); break; }
    }
  } catch (error) {
    if (!(error instanceof SlackError) || ["slack_reconnect_required", "slack_access_denied"].includes(error.code) || !context.evidence.length) throw error;
    context.limitations.push(`Consulta parcial por falha do Slack (${error.code}).`);
  }
  const current = await loadSlackConnection(uid);
  if (current.generation !== connection.generation || ids.some((id) => !current.selectedChannels.some((channel) => channel.id === id))) throw new SlackError("slack_connection_changed", 409);
  context.limitations.push("Replies só são consultados para threads cujas mensagens principais foram recuperadas nesta janela.");
  context.limitations = [...new Set(context.limitations)];
  return context;
}
