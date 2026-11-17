import "server-only";
import { createHash } from "node:crypto";
import { getAdminDb } from "./firebase-admin";
import type { AssistantConfig } from "./assistant-config";
import { AssistantError } from "./assistant-validation";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Reserve before reading context or calling a provider. Failed calls also consume quota. */
export async function reserveAssistantUsage(uid: string, requestId: string, config: AssistantConfig, now = Date.now()) {
  const db = getAdminDb();
  const day = new Date(now).toISOString().slice(0, 10);
  const minute = Math.floor(now / 60000);
  const usage = db.collection("private_assistant_usage").doc(`${hash(uid)}_${day}`);
  const global = db.collection("private_assistant_usage").doc(`global_${day}`);
  const request = db.collection("ai_usage_logs").doc(hash(JSON.stringify([uid, requestId])));
  await db.runTransaction(async transaction => {
    const [ownSnapshot, globalSnapshot, previous] = await transaction.getAll(usage, global, request);
    if (previous.exists) throw new AssistantError(409, "duplicate_request", "Esta requisição já foi recebida. Use um novo identificador para outra pergunta.");
    const own = ownSnapshot.data() ?? {};
    const total = globalSnapshot.data()?.count ?? 0;
    const recent = own.minute === minute ? own.minute_count ?? 0 : 0;
    if ((own.count ?? 0) >= config.perDay || total >= config.globalPerDay) {
      const seconds = Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000 - now) / 1000);
      throw new AssistantError(429, "daily_quota", "O limite diário do assistente foi atingido.", seconds);
    }
    if (recent >= config.perMinute) throw new AssistantError(429, "rate_limit", "Aguarde antes de enviar outra pergunta.", 60);
    const expiresAt = new Date(now + 30 * 86400000);
    transaction.set(usage, { count: (own.count ?? 0) + 1, minute, minute_count: recent + 1, expires_at: expiresAt });
    transaction.set(global, { count: total + 1, expires_at: expiresAt });
    transaction.create(request, { status: "reserved", model: config.model, created_at: new Date(now), expires_at: expiresAt });
  });
  return request;
}

export async function finishAssistantUsage(reference: Awaited<ReturnType<typeof reserveAssistantUsage>>, status: "success" | "error", evidenceCount: number, code: string, started: number) {
  await reference.update({ status, evidence_count: evidenceCount, code, duration_ms: Math.max(0, Date.now() - started) });
}
