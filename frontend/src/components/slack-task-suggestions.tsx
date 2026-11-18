"use client";

import { useCallback, useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase";
import type { SlackTaskSuggestion } from "@/lib/slack-task-suggestions";
import type { TaskCard } from "@/lib/task-board";
import { Button } from "@/components/ui";

async function request(path: string, init?: RequestInit) {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("Faça login para consultar sugestões.");
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${await user.getIdToken()}`, ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Não foi possível atualizar as sugestões.");
  return body;
}

export async function updateSlackSuggestion(id: string, status: "accepted" | "ignored", task?: TaskCard) { return request("/api/slack-suggestions", { method: "PATCH", body: JSON.stringify({ id, status, ...(task ? { task } : {}) }) }) as Promise<{ card?: TaskCard }> ; }

export function SlackTaskSuggestions({ onReview }: { onReview: (item: SlackTaskSuggestion) => void }) {
  const [items, setItems] = useState<SlackTaskSuggestion[]>([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { try { const body = await request("/api/slack-suggestions"); setItems(body.suggestions); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao carregar sugestões."); } finally { setLoading(false); } }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = () => { void load(); };
    window.addEventListener("nexusclass:slack-suggestions-updated", refresh);
    return () => { clearTimeout(initial); window.removeEventListener("nexusclass:slack-suggestions-updated", refresh); };
  }, [load]);
  if (loading) return <p className="muted" role="status">Consultando sugestões do Slack…</p>;
  if (!items.length && !error) return null;
  return <section className="panel slack-suggestions" aria-labelledby="slack-suggestions-title"><div className="slack-suggestions-heading"><div><h2 id="slack-suggestions-title">Sugestões do Slack</h2><p className="muted">Revise antes de adicionar ao quadro.</p></div><span>{items.length}</span></div>{error && <p className="form-error" role="alert">{error}</p>}{items.map((item) => <article key={item.id} className="slack-suggestion"><div><strong>{item.title}</strong><p>{item.excerpt}</p><small>#{item.channel} · {item.sender}</small></div><div className="slack-suggestion-actions"><Button type="button" className="button-ghost button-small" onClick={() => { void updateSlackSuggestion(item.id, "ignored").then(() => { setItems((current) => current.filter((entry) => entry.id !== item.id)); setError(""); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Não foi possível ignorar a sugestão.")); }}>Ignorar</Button><Button type="button" className="button-small" onClick={() => onReview(item)}>Revisar</Button></div></article>)}</section>;
}
