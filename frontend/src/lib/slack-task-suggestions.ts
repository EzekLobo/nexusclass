import { isTaskDate, TASK_CATEGORIES, type TaskKind, type TaskPriority } from "@/lib/task-board";

export type SlackTaskSuggestion = {
  id: string;
  source_url: string;
  channel: string;
  sender: string;
  excerpt: string;
  title: string;
  description: string;
  kind: TaskKind;
  priority: TaskPriority;
  category: string;
  due_date: string | null;
  status: "pending" | "accepted" | "ignored";
  created_at: string;
};

const text = (value: unknown, maximum: number) => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export function parseGeminiTask(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.actionable !== true) return null;
  const title = text(item.title, 160);
  if (!title) return null;
  const dueDate = isTaskDate(item.due_date) ? item.due_date : null;
  const category = TASK_CATEGORIES.find((candidate) => candidate === text(item.category, 80)) ?? "Outros";
  return {
    title,
    description: text(item.description, 4000),
    kind: item.kind === "problem" ? "problem" as const : "task" as const,
    priority: ["low", "normal", "high", "urgent"].includes(String(item.priority)) ? item.priority as TaskPriority : "normal" as const,
    category,
    due_date: dueDate,
  };
}

export function parseSuggestion(value: unknown): SlackTaskSuggestion | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const task = parseGeminiTask({ ...item, actionable: true });
  if (!task || typeof item.id !== "string" || !/^[a-f0-9]{40}$/.test(item.id) || !["pending", "accepted", "ignored"].includes(String(item.status)) || typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at))) return null;
  const sourceUrl = text(item.source_url, 2000);
  try { const parsed = new URL(sourceUrl); if (parsed.protocol !== "https:" || !/(^|\.)slack\.com$/i.test(parsed.hostname)) return null; } catch { return null; }
  return {
    id: item.id, source_url: sourceUrl, channel: text(item.channel, 120),
    sender: text(item.sender, 160), excerpt: text(item.excerpt, 500), ...task,
    status: item.status as SlackTaskSuggestion["status"], created_at: text(item.created_at, 40),
  };
}
