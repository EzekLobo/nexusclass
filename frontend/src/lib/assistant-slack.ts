import "server-only";
import { readSlackContext } from "./slack-context";
import { SlackError } from "./slack-server";
import type { AssistantContext } from "./assistant-activities";
import type { AssistantAskInput } from "./assistant-contract";
import { AssistantError, assistantSafeText } from "./assistant-validation";

/** Compose only server-authorized evidence. A failed Slack read never becomes an empty-success claim. */
export async function appendAssistantSlack(uid: string, input: AssistantAskInput, activities: AssistantContext): Promise<AssistantContext> {
  if (!input.include_slack) return activities;
  try {
    const context = await readSlackContext(uid, { conversationIds: input.slack_conversation_ids });
    const authors = new Map<string, string>();
    const evidence = context.evidence.map((item, index) => {
      const ref = `slack_${index + 1}`;
      if (!authors.has(item.author_id)) authors.set(item.author_id, `slack_author_${authors.size + 1}`);
      return {
        source: { source: "slack" as const, ref, label: `${assistantSafeText(item.label) || "Mensagem Slack"} · ${item.timestamp}`, href: "/settings/slack" },
        data: { ref, text: assistantSafeText(item.text, 1500), timestamp: item.timestamp, author: authors.get(item.author_id)! },
      };
    });
    return { evidence: [...activities.evidence, ...evidence], limitations: [...activities.limitations, ...context.limitations] };
  } catch (error) {
    if (error instanceof SlackError && ["slack_channel_not_selected", "slack_invalid_channels", "slack_invalid_window"].includes(error.code)) {
      throw new AssistantError(error.status, "slack_context_not_authorized", "A seleção de canais Slack não está autorizada.");
    }
    return { ...activities, limitations: [...activities.limitations, "Não foi possível consultar o Slack. A resposta considera somente as atividades disponíveis no servidor."] };
  }
}
