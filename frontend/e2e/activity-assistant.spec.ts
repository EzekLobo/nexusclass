import { expect, test } from "@playwright/test";

for (const width of [320, 390, 1440]) {
  test(`assistente demo acessível e local (${width}px)`, async ({ page }, testInfo) => {
    const privateRequests: string[] = [];
    page.on("request", request => {
      if (/\/api\/(assistant|integrations\/slack)|firestore\.googleapis|identitytoolkit\.googleapis|generativelanguage\.googleapis|slack\.com\/api/.test(request.url())) privateRequests.push(request.url());
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/demo#classes");
    const trigger = page.getByRole("button", { name: "Abrir assistente de atividades", exact: true });
    await expect(trigger).toBeVisible();
    const bounds = await trigger.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Assistente de atividades", exact: true });
    await expect(dialog).toBeVisible();
    const question = dialog.getByRole("textbox", { name: "Pergunta", exact: true });
    await expect(question).toBeFocused();
    const submit = dialog.getByRole("button", { name: "Perguntar", exact: true });
    await expect(submit).toBeDisabled();
    await question.fill("   ");
    await expect(submit).toBeDisabled();
    await question.fill("Quais atividades precisam de acompanhamento?");
    await expect(submit).toBeEnabled();
    await submit.scrollIntoViewIfNeeded();
    const buttonGeometry = await submit.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(button);
      const text = range.getBoundingClientRect();
      return { lines: range.getClientRects().length, fits: text.left >= bounds.left && text.right <= bounds.right && text.top >= bounds.top && text.bottom <= bounds.bottom };
    });
    expect(buttonGeometry).toEqual({ lines: 1, fits: true });
    await expect(dialog.getByRole("combobox", { name: "Turma", exact: true })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Aluno", exact: true })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Aula", exact: true })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Atividade", exact: true })).toBeVisible();
    await dialog.getByRole("checkbox", { name: "Incluir Slack", exact: true }).check();
    await submit.click();
    const answer = dialog.getByRole("region", { name: "Resposta do assistente" });
    await expect(answer).toBeVisible();
    await expect(answer).toBeFocused();
    await expect(answer).toContainText("Exemplo fictício");
    await expect(answer).toContainText("situação é desconhecida ou sem avaliação");
    await expect(answer).toContainText("Nenhuma mensagem foi consultada");
    await expect(answer).toContainText("Brasília");
    await expect(answer.getByRole("link", { name: "Roteiro demonstrativo de atividades" })).toHaveAttribute("href", "/demo#classes");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`assistant-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog.getByRole("region", { name: "Resposta do assistente" })).toContainText("Exemplo fictício");
    expect(privateRequests).toEqual([]);
  });
}
