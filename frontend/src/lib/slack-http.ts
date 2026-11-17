import "server-only";
import { RequestAuthError } from "@/lib/server-auth";
import { SlackError } from "@/lib/slack-server";

export function slackJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function slackHttpError(error: unknown) {
  if (error instanceof RequestAuthError) return slackJson({ code: "unauthenticated", message: error.message }, error.status);
  if (error instanceof SlackError) return slackJson({ code: error.code, message: slackErrorMessage(error.code) }, error.status, error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
  return slackJson({ code: "slack_unavailable", message: "Não foi possível concluir a operação Slack." }, 503);
}

function slackErrorMessage(code: string) {
  switch (code) {
    case "slack_not_configured": return "O administrador precisa configurar o conector Slack no servidor.";
    case "slack_disconnect_first": return "Desconecte a integração anterior antes de autorizar outro workspace. Se a revogação ficou pendente, tente desconectar novamente.";
    case "slack_rate_limited": return "O Slack limitou as consultas. Aguarde antes de tentar novamente.";
    case "slack_access_denied": return "Confira seu acesso e participação nos canais selecionados.";
    case "slack_reconnect_required": return "A autorização Slack expirou ou foi revogada. Desconecte e conecte novamente.";
    case "slack_invalid_channels": return "Selecione até cinco canais distintos.";
    case "slack_disconnected": return "Conecte o Slack para continuar.";
    default: return "Não foi possível concluir a operação Slack. Recarregue e tente novamente.";
  }
}

export async function slackChannelBody(request: Request) {
  if (!request.body) throw new SlackError("slack_invalid_input", 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2048) {
        await reader.cancel();
        throw new SlackError("slack_invalid_input", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new SlackError("slack_invalid_input", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("channelIds" in value)) throw new SlackError("slack_invalid_input", 400);
  return value.channelIds;
}
