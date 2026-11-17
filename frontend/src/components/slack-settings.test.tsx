import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";
vi.mock("next/link", () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
import { SlackSettings } from "./slack-settings";
it("demo tem aviso e conexão desabilitada sem acessar provedor", () => {
  const adapter = { status: vi.fn(), connect: vi.fn(), channels: vi.fn(), select: vi.fn(), disconnect: vi.fn() };
  const markup = renderToStaticMarkup(<SlackSettings demo adapter={adapter} />);
  expect(markup).toContain("demonstração usa dados locais");
  expect(markup).toContain("Conectar Slack"); expect(markup).toContain("disabled");
  expect(adapter.status).not.toHaveBeenCalled(); expect(adapter.connect).not.toHaveBeenCalled();
});
it("trocar proprietário remonta o componente e seus rascunhos", () => {
  const first = SlackSettings({ ownerUid: "alice" });
  const second = SlackSettings({ ownerUid: "bob" });
  expect(first.key).toBe("alice"); expect(second.key).toBe("bob");
  expect(first.key).not.toBe(second.key);
});
