import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityAssistant, AssistantAnswerView } from "./activity-assistant";

describe("assistente de atividades", () => {
  it("demo apresenta campos acessíveis e envio vazio desabilitado", () => {
    const html = renderToStaticMarkup(<ActivityAssistant activities={[]} demo />);
    expect(html).toContain('aria-label="Abrir assistente de atividades"');
    expect(html).toContain('title="Assistente de atividades"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('disabled="">Perguntar');
    expect(html).toContain("sem consultas externas");
  });

  it("renderiza fontes e resposta como texto, com horário de Brasília", () => {
    const html = renderToStaticMarkup(<AssistantAnswerView result={{ consultedAt: "2026-11-17T12:00:00Z", value: {
      request_id: "request-123", answer: "<script>alert(1)</script>", insufficient_context: true,
      sources: [{ source: "slack", ref: "slack1", label: "<img src=x>", href: "javascript:alert(1)" }], limitations: ["Fonte indisponível"],
    } }} />);
    expect(html).toContain("Contexto insuficiente");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("09:00:00");
    expect(html).toContain("Brasília");
    expect(html).toContain("Fonte indisponível");
  });
});
