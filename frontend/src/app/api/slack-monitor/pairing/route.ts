import { createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { authenticatedUser, assertSlackMonitorOwner, RequestAuthError, isOwnerAdministrator } from "@/lib/server-auth";
import { getAdminDb } from "@/lib/firebase-admin";

export const runtime = "nodejs";
const digest = (code: string) => createHash("sha256").update(code).digest("hex");
function fail(error: unknown) { const status = error instanceof RequestAuthError ? error.status : 500; return Response.json({ error: error instanceof Error ? error.message : "Falha inesperada." }, { status }); }

export async function GET(request: Request) {
  try {
    const user = await authenticatedUser(request);
    if (!isOwnerAdministrator(user.email)) return Response.json({ available: false, connected: false });
    const snapshot = await getAdminDb().collection("slack_monitor_devices").where("uid", "==", user.uid).get();
    const device = snapshot.docs.map((document) => document.data()).find((candidate) => candidate.revoked !== true);
    return Response.json({ connected: Boolean(device), paired_at: device?.created_at ?? null });
  } catch (error) { return fail(error); }
}

export async function POST(request: Request) {
  try {
    const user = await authenticatedUser(request);
    assertSlackMonitorOwner(user);
    const body = await request.json() as { public_key?: unknown };
    if (typeof body.public_key !== "string" || body.public_key.length > 2000) return Response.json({ error: "Chave pública inválida." }, { status: 400 });
    let key;
    try { key = createPublicKey(body.public_key); } catch { return Response.json({ error: "Chave pública inválida." }, { status: 400 }); }
    if (key.asymmetricKeyType !== "ed25519") return Response.json({ error: "O monitor precisa usar uma chave Ed25519." }, { status: 400 });
    const code = randomBytes(32).toString("base64url");
    const deviceId = randomUUID();
    await getAdminDb().doc(`slack_monitor_pairings/${digest(code)}`).create({ uid: user.uid, device_id: deviceId, public_key: body.public_key, expires_at: Date.now() + 5 * 60_000, created_at: new Date().toISOString() });
    return Response.json({ code, expires_in_seconds: 300 });
  } catch (error) { return fail(error); }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as { code?: unknown; public_key?: unknown };
    if (typeof body.code !== "string" || typeof body.public_key !== "string" || body.code.length > 100) return Response.json({ error: "Código de vínculo inválido." }, { status: 400 });
    const db = getAdminDb(); const pairingRef = db.doc(`slack_monitor_pairings/${digest(body.code)}`);
    const outcome = await db.runTransaction(async (transaction) => {
      const pairing = await transaction.get(pairingRef);
      if (!pairing.exists || pairing.data()?.expires_at < Date.now() || pairing.data()?.public_key !== body.public_key) return null;
      const data = pairing.data()!;
      const deviceRef = db.doc(`slack_monitor_devices/${data.device_id}`);
      transaction.create(deviceRef, { uid: data.uid, device_id: data.device_id, public_key: data.public_key, revoked: false, created_at: new Date().toISOString() });
      transaction.delete(pairingRef);
      return { device_id: data.device_id };
    });
    return outcome ? Response.json({ ok: true, ...outcome }) : Response.json({ error: "Código expirado ou inválido. Gere outro vínculo." }, { status: 410 });
  } catch (error) { return fail(error); }
}

export async function DELETE(request: Request) {
  try {
    const user = await authenticatedUser(request);
    assertSlackMonitorOwner(user);
    const db = getAdminDb();
    const devices = await db.collection("slack_monitor_devices").where("uid", "==", user.uid).get();
    const batch = db.batch(); devices.docs.forEach((device) => batch.update(device.ref, { revoked: true, revoked_at: new Date().toISOString() }));
    if (!devices.empty) await batch.commit();
    return Response.json({ ok: true });
  } catch (error) { return fail(error); }
}
