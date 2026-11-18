import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase-admin";
import { classifySlackMessage, suggestionId, suggestionFromMessage, validateSlackWebMessage, verifyDeviceSignature } from "@/lib/slack-ingestion";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 12_288) return Response.json({ error: "Mensagem muito grande." }, { status: 413 });
  const timestamp = request.headers.get("x-monitor-timestamp");
  const deviceId = request.headers.get("x-monitor-device");
  const signature = request.headers.get("x-monitor-signature");
  if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) return Response.json({ error: "Dispositivo não autenticado." }, { status: 401 });
  const db = getAdminDb();
  const device = await db.doc(`slack_monitor_devices/${deviceId}`).get();
  const publicKey = device.data()?.public_key;
  if (!device.exists || device.data()?.revoked === true || typeof publicKey !== "string" || !verifyDeviceSignature(raw, timestamp, signature, publicKey)) return Response.json({ error: "Assinatura do dispositivo inválida ou expirada." }, { status: 401 });
  try {
    const message = validateSlackWebMessage(JSON.parse(raw));
    const id = suggestionId(message);
    const reference = db.doc(`users/${device.data()?.uid}/slack_task_suggestions/${id}`);
    if ((await reference.get()).exists) return Response.json({ ok: true, duplicate: true });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const usageRef = db.doc(`slack_monitor_usage/${deviceId}_${today.replaceAll("-", "")}`);
    const withinDailyLimit = await db.runTransaction(async (transaction) => {
      const usage = await transaction.get(usageRef);
      const count = Number(usage.data()?.count ?? 0);
      if (count >= 50) return false;
      transaction.set(usageRef, { device_id: deviceId, day: today, count: count + 1, updated_at: new Date().toISOString() });
      return true;
    });
    if (!withinDailyLimit) return Response.json({ error: "Limite de 50 análises por dia atingido." }, { status: 429, headers: { "retry-after": "3600" } });
    const task = await classifySlackMessage(message);
    if (!task) return Response.json({ ok: true, actionable: false });
    const suggestion = suggestionFromMessage(message, task, id);
    try {
      await reference.create({ ...suggestion, updated_at: suggestion.created_at, server_created_at: FieldValue.serverTimestamp() });
      return Response.json({ ok: true, actionable: true, id }, { status: 201 });
    } catch (error) {
      if ((error as { code?: number }).code === 6) return Response.json({ ok: true, duplicate: true });
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao processar a mensagem.";
    const status = /inválid|fora da lista permitida/i.test(message) ? 400 : 502;
    return Response.json({ error: message }, { status });
  }
}
