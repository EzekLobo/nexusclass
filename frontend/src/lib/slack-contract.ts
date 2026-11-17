export const SLACK_CONTEXT_LIMITATION = "A consulta usa uma janela limitada de mensagens e threads dos canais selecionados e pode retornar contexto parcial.";

export type SlackChannel = { id: string; name: string; private: boolean };
export type SlackStatus = {
  connected: boolean;
  configured: boolean;
  workspace: { id: string; name: string } | null;
  selectedChannels: SlackChannel[];
  limitations: string[];
};
export type SlackEvidence = {
  source: "slack";
  ref: string;
  label: string;
  text: string;
  channel_id: string;
  thread_ts: string;
  timestamp: string;
  author_id: string;
  untrusted: true;
};
export type SlackContext = { evidence: SlackEvidence[]; limitations: string[]; queried_at: string };
export type SlackContextInput = { conversationIds?: string[]; oldest?: number; latest?: number };
