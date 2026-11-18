import { authenticatedUser, assertSlackMonitorOwner, isOwnerAdministrator, RequestAuthError } from "@/lib/server-auth";
import { getAdminDb } from "@/lib/firebase-admin";
import { parseSuggestion } from "@/lib/slack-task-suggestions";
import { validateTaskCard } from "@/lib/task-board";

export const runtime = "nodejs";
function failure(error: unknown) { const status = error instanceof RequestAuthError ? error.status : 500; return Response.json({ error: error instanceof Error ? error.message : "Falha inesperada." }, { status }); }

export async function GET(request: Request) {
  try {
    const user = await authenticatedUser(request);
    if (!isOwnerAdministrator(user.email)) return Response.json({ suggestions: [] });
    const snapshot = await getAdminDb().collection(`users/${user.uid}/slack_task_suggestions`).where("status", "==", "pending").limit(50).get();
    const suggestions = snapshot.docs.map((doc) => parseSuggestion(doc.data())).filter((item) => item !== null).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Response.json({ suggestions });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    const user = await authenticatedUser(request);
    assertSlackMonitorOwner(user);
    const body = await request.json() as { id?: unknown; status?: unknown; task?: unknown };
    if (typeof body.id !== "string" || !/^[a-f0-9]{40}$/.test(body.id) || !["accepted", "ignored"].includes(String(body.status))) return Response.json({ error: "Atualização inválida." }, { status: 400 });
    const db = getAdminDb(); const reference = db.doc(`users/${user.uid}/slack_task_suggestions/${body.id}`);
    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return { error: "Sugestão não encontrada.", status: 404 as const };
      const suggestion = parseSuggestion(snapshot.data());
      if (!suggestion) return { error: "Sugestão inválida.", status: 409 as const };
      if (suggestion.status === "accepted" && typeof snapshot.data()?.task_card_id === "string") {
        const savedRef = db.doc(`users/${user.uid}/task_cards/${snapshot.data()!.task_card_id}`);
        const saved = await transaction.get(savedRef);
        return saved.exists ? { ok: true, alreadyProcessed: true, card: validateTaskCard({ ...saved.data(), id: saved.id }) } : { error: "A tarefa associada não foi encontrada.", status: 404 as const };
      }
      if (suggestion.status !== "pending") return { ok: true, alreadyProcessed: true };
      const now = new Date().toISOString();
      if (body.status === "ignored") { transaction.update(reference, { status: "ignored", updated_at: now }); return { ok: true }; }
      let card;
      try { card = validateTaskCard(body.task); } catch (error) { return { error: error instanceof Error ? error.message : "Tarefa inválida.", status: 400 as const }; }
      if (card.id !== `slack_${suggestion.id}`) return { error: "Identificador da tarefa não corresponde à sugestão.", status: 400 as const };
      transaction.set(db.doc(`users/${user.uid}/task_cards/${card.id}`), card);
      transaction.update(reference, { status: "accepted", task_card_id: card.id, updated_at: now });
      return { ok: true, card };
    });
    return "error" in result ? Response.json({ error: result.error }, { status: result.status }) : Response.json(result);
  } catch (error) { return failure(error); }
}
