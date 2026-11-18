import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { chromium } from "playwright";
import { extractUnreadMessages, isLoginRequired, normalizeAllowedConfig } from "./slack-page.mjs";

const dataDirectory = process.env.NEXUSCLASS_SLACK_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "NexusClass", "SlackMonitor");
const profileDirectory = path.join(dataDirectory, "browser-profile");
const configFile = path.join(dataDirectory, "config.json");
const keyFile = path.join(dataDirectory, "device-key.json");
const stateFile = path.join(dataDirectory, "state.json");
const port = Number(process.env.NEXUSCLASS_SLACK_MONITOR_PORT || "49321");
const defaultOrigins = ["https://nexusclass.vercel.app", "http://localhost:3000", "http://127.0.0.1:3000"];
const allowedOrigins = new Set((process.env.NEXUSCLASS_SLACK_ALLOWED_ORIGINS || defaultOrigins.join(",")).split(",").map((value) => value.trim()).filter(Boolean));
let context;
let browserPage;
let visibleContext = false;
let status = { state: "unconfigured", last_scan: null, error: null };
let scanning = false;

await mkdir(dataDirectory, { recursive: true });
await mkdir(profileDirectory, { recursive: true });

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function writePrivateJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
}

async function getKeys() {
  const saved = await readJson(keyFile);
  if (saved?.privateKey && saved?.publicKey) return saved;
  const pair = generateKeyPairSync("ed25519");
  const result = { privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
  await writePrivateJson(keyFile, result);
  return result;
}

async function getConfig() { return normalizeAllowedConfig(await readJson(configFile, {})); }

async function closeContext() {
  if (context) await context.close().catch(() => undefined);
  context = undefined; browserPage = undefined; visibleContext = false;
}

async function openSlack({ visible = false } = {}) {
  const config = await getConfig();
  if (!config.channelUrls.length) throw new Error("Configure os links dos dois canais em Configurações do NexusClass.");
  if (context) {
    if (visible && context.pages()[0]) await context.pages()[0].bringToFront();
    return context.pages()[0];
  }
  context = await chromium.launchPersistentContext(profileDirectory, { headless: !visible, viewport: { width: 1280, height: 900 }, locale: "pt-BR" });
  visibleContext = visible;
  browserPage = context.pages()[0] || await context.newPage();
  const teamId = new URL(config.channelUrls[0]).pathname.split("/").filter(Boolean)[1];
  if (!/^T[A-Z0-9]+$/i.test(teamId || "")) throw new Error("Os links devem estar no formato copiado do Slack, contendo o identificador do workspace.");
  await browserPage.goto(`https://app.slack.com/client/${teamId}/unreads`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  return browserPage;
}

async function persistProcessed(message, result) {
  const state = await readJson(stateFile, { processed: {} });
  state.processed[`${message.channel}:${message.message_id}`] = { outcome: result, at: new Date().toISOString() };
  const entries = Object.entries(state.processed);
  if (entries.length > 5000) state.processed = Object.fromEntries(entries.sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 4000));
  await writePrivateJson(stateFile, state);
}

async function postMessage(message) {
  const pair = await readJson(keyFile);
  const config = await getConfig();
  if (!pair?.deviceId || !pair.privateKey || !config.apiBase) throw new Error("Vincule o monitor ao NexusClass em Configurações → Integrações.");
  const raw = JSON.stringify(message);
  const timestamp = String(Date.now());
  const signature = sign(null, Buffer.from(`${timestamp}.${raw}`), createPrivateKey(pair.privateKey)).toString("base64url");
  const response = await fetch(new URL("/api/integrations/slack-web/messages", config.apiBase), { method: "POST", headers: { "content-type": "application/json", "x-monitor-device": pair.deviceId, "x-monitor-timestamp": timestamp, "x-monitor-signature": signature }, body: raw, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `O NexusClass respondeu ${response.status}.`);
  return body;
}

async function scan() {
  if (scanning) return { busy: true, processed: 0 };
  scanning = true;
  try {
    const config = await getConfig();
    const keys = await readJson(keyFile);
    if (!config.mentionText || config.channelUrls.length !== 2 || !keys?.deviceId) throw new Error("Configure os canais, sua menção e o vínculo local nas Integrações.");
    const page = await openSlack();
    if (await isLoginRequired(page)) { status = { ...status, state: "needs_login", error: "Entre novamente no Slack para retomar a consulta." }; return { needs_login: true, processed: 0 }; }
    if (visibleContext) {
      await closeContext();
      browserPage = await openSlack();
      if (await isLoginRequired(browserPage)) { status = { ...status, state: "needs_login", error: "Não foi possível validar a sessão do Slack." }; return { needs_login: true, processed: 0 }; }
    }
    const messages = await extractUnreadMessages(browserPage || page, config);
    const state = await readJson(stateFile, { processed: {} });
    let processed = 0;
    const pending = messages.filter((message) => !state.processed[`${message.channel}:${message.message_id}`]).slice(0, 20);
    for (const message of pending) {
      const id = `${message.channel}:${message.message_id}`;
      const result = await postMessage(message);
      await persistProcessed(message, result.actionable ? "suggestion" : result.duplicate ? "duplicate" : "not_actionable");
      state.processed[id] = { at: new Date().toISOString() };
      processed++;
    }
    status = { state: "connected", last_scan: new Date().toISOString(), error: null };
    return { processed };
  } catch (error) {
    status = { ...status, state: "error", error: error instanceof Error ? error.message : "Falha ao consultar o Slack." };
    throw error;
  } finally { scanning = false; }
}

function corsHeaders(origin) {
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600", "access-control-allow-private-network": "true", vary: "origin" };
}

function sendJson(response, statusCode, value, origin) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(origin ? corsHeaders(origin) : {}) });
  response.end(statusCode === 204 ? undefined : JSON.stringify(value));
}

async function requestBody(request) {
  let raw = "";
  for await (const chunk of request) { raw += chunk; if (raw.length > 16_384) throw new Error("Solicitação muito grande."); }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (origin && !allowedOrigins.has(origin)) { sendJson(response, 403, { error: "Origem não autorizada." }); return; }
  if (request.method === "OPTIONS") { sendJson(response, 204, {}, origin); return; }
  const pathname = new URL(request.url || "/", `http://127.0.0.1:${port}`).pathname;
  try {
    if (pathname === "/health" && request.method === "GET") {
      const saved = await readJson(keyFile);
      sendJson(response, 200, { ...status, paired: Boolean(saved?.deviceId), configured: Boolean((await getConfig()).mentionText), config: await getConfig() }, origin); return;
    }
    if (pathname === "/info" && request.method === "GET") { const keys = await getKeys(); sendJson(response, 200, { publicKey: keys.publicKey }, origin); return; }
    if (pathname === "/configure" && request.method === "PUT") {
      const config = normalizeAllowedConfig(await requestBody(request));
      if (config.channelUrls.length !== 2 || !config.mentionText) { sendJson(response, 400, { error: "Informe os links dos dois canais e o texto exato da sua menção." }, origin); return; }
      const current = await getConfig();
      await writePrivateJson(configFile, { ...config, apiBase: current.apiBase });
      status = { ...status, state: "configured", error: null };
      sendJson(response, 200, { ok: true }, origin); return;
    }
    if (pathname === "/pair" && request.method === "POST") {
      const body = await requestBody(request); const keys = await getKeys();
      const apiUrl = typeof body.apiBase === "string" ? new URL(body.apiBase) : null;
      if (typeof body.code !== "string" || !apiUrl || !(apiUrl.origin === "https://nexusclass.vercel.app" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(apiUrl.origin))) { sendJson(response, 400, { error: "Código de vínculo ou endereço do NexusClass inválido." }, origin); return; }
      const configured = await getConfig(); await writePrivateJson(configFile, { ...configured, apiBase: body.apiBase });
      const result = await fetch(new URL("/api/slack-monitor/pairing", body.apiBase), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: body.code, public_key: keys.publicKey }), signal: AbortSignal.timeout(10_000) });
      const payload = await result.json().catch(() => ({}));
      if (!result.ok || typeof payload.device_id !== "string") throw new Error(payload.error || "Não foi possível vincular o dispositivo.");
      await writePrivateJson(keyFile, { ...keys, deviceId: payload.device_id });
      status = { ...status, state: "paired", error: null };
      sendJson(response, 200, { ok: true }, origin); return;
    }
    if (pathname === "/login" && request.method === "POST") {
      await closeContext(); const page = await openSlack({ visible: true }); await page.bringToFront();
      sendJson(response, 200, { opened: true }, origin); return;
    }
    if (pathname === "/scan" && request.method === "POST") {
      const result = await scan(); sendJson(response, 200, { ...result, ...status }, origin); return;
    }
    if (pathname === "/disconnect" && request.method === "POST") {
      const keys = await readJson(keyFile, {}); await writePrivateJson(keyFile, { publicKey: keys.publicKey, privateKey: keys.privateKey });
      sendJson(response, 200, { ok: true }, origin); return;
    }
    sendJson(response, 404, { error: "Rota não encontrada." }, origin);
  } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "Solicitação inválida." }, origin); }
});

server.listen(port, "127.0.0.1", () => console.log(`NexusClass Slack Monitor ouvindo em http://127.0.0.1:${port}`));
for (const signalName of ["SIGINT", "SIGTERM"]) process.on(signalName, async () => { await closeContext(); server.close(() => process.exit(0)); });

export { server, scan };
