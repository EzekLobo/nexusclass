import { describe, expect, it } from "vitest";
import { parseGeminiTask } from "@/lib/slack-task-suggestions";

const suggestion = { actionable: true, title: "Revisar atividade", description: "Conferir o material", kind: "task", priority: "normal", due_date: "" };

describe("Slack task suggestions", () => {
  it("keeps task categories compatible with the board editor", () => {
    expect(parseGeminiTask({ ...suggestion, category: "Aula" })?.category).toBe("Aula");
    expect(parseGeminiTask({ ...suggestion, category: "Slack" })?.category).toBe("Outros");
    expect(parseGeminiTask({ ...suggestion, category: "" })?.category).toBe("Outros");
  });
});
