"use client";

import { useCallback, useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase";
import { Button, Input } from "@/components/ui";

const LOCAL_MONITOR = "http://127.0.0.1:49321";
type LocalStatus = { state?: string; last_scan?: string | null; error?: string | null; paired?: boolean; configured?: boolean };
const defaultConfig = { channelUrls: ["", ""], mentionText: "" };

async function localRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${LOCAL_MONITOR}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers }, signal: init?.signal ?? AbortSignal.timeout(8_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Não foi possível acessar o monitor local.");
  return body as T;
}

async function accountRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error("Entre novamente no NexusClass.");
  const response = await fetch(path, { ...init, headers: { authorization: `Bearer ${await user.getIdToken()}`, "content-type": "application/json", ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Não foi possível salvar a integração.");
  return body as T;
}

export function SlackMonitorSettings({ enabled = true }: { enabled?: boolean }) {
  const [channels, setChannels] = useState<[string, string]>(defaultConfig.channelUrls as [string, string]);
  const [mentionText, setMentionText] = useState("");
  const [status, setStatus] = useState<LocalStatus>({});
  const [available, setAvailable] = useState(false);
  const [availabilityChecked, setAvailabilityChecked] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const [localResult, remoteResult] = await Promise.allSettled([
      localRequest<LocalStatus & { config?: { channelUrls?: string[]; mentionText?: string } }>("/health"),
      accountRequest<{ connected: boolean; available?: boolean }>("/api/slack-monitor/pairing"),
    ]);
    if (remoteResult.status === "fulfilled") {
      setAvailable(remoteResult.value.available !== false);
      setConnected(remoteResult.value.connected);
      setAvailabilityChecked(true);
    } else {
      setAvailable(true);
      setAvailabilityChecked(true);
    }
    if (localResult.status === "fulfilled") {
      const local = localResult.value;
      setStatus(local);
      if (local.config?.channelUrls?.length === 2) setChannels([local.config.channelUrls[0]!, local.config.channelUrls[1]!]);
      if (local.config?.mentionText) setMentionText(local.config.mentionText);
    } else setStatus({ state: "unavailable" });
    if (localResult.status === "rejected" || remoteResult.status === "rejected") {
      const reason = localResult.status === "rejected" ? localResult.reason : remoteResult.status === "rejected" ? remoteResult.reason : null;
      setError(reason instanceof Error ? reason.message : "Monitor local indisponível.");
    } else setError("");
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh, enabled]);

  async function saveConfiguration() {
    setBusy(true); setError(""); setNotice("");
    try {
      await localRequest("/configure", { method: "PUT", body: JSON.stringify({ channelUrls: channels, mentionText }) });
      setNotice("Canais e menção salvos neste computador."); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível salvar a configuração."); }
    finally { setBusy(false); }
  }

  async function openSlackLogin() {
    setBusy(true); setError(""); setNotice("");
    try { await localRequest("/login", { method: "POST" }); setNotice("Slack aberto. Entre manualmente; depois volte aqui e vincule o monitor."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível abrir o Slack."); }
    finally { setBusy(false); }
  }

  async function pairMonitor() {
    setBusy(true); setError(""); setNotice("");
    try {
      await localRequest("/configure", { method: "PUT", body: JSON.stringify({ channelUrls: channels, mentionText }) });
      const info = await localRequest<{ publicKey: string }>("/info");
      const pairing = await accountRequest<{ code: string }>("/api/slack-monitor/pairing", { method: "POST", body: JSON.stringify({ public_key: info.publicKey }) });
      await localRequest("/pair", { method: "POST", body: JSON.stringify({ code: pairing.code, apiBase: window.location.origin }) });
      setConnected(true); setNotice("Monitor vinculado. A consulta começará ao entrar no NexusClass e repetirá a cada cinco minutos.");
      window.dispatchEvent(new Event("nexusclass:slack-monitor-paired")); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível vincular o monitor."); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setError(""); setNotice("");
    try {
      await accountRequest("/api/slack-monitor/pairing", { method: "DELETE" });
      await localRequest("/disconnect", { method: "POST" });
      setConnected(false); setNotice("Monitor desvinculado."); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível desvincular."); }
    finally { setBusy(false); }
  }

  if (!enabled) return <section className="panel settings-section"><h3>Slack</h3><p>O monitor local está disponível na sua conta autenticada.</p></section>;
  if (!availabilityChecked || !available) return null;
  const stateText = status.state === "connected" ? "Conectado" : status.state === "needs_login" ? "Slack precisa de novo login" : status.state === "error" ? status.error || "Falha na última consulta" : connected ? "Vinculado; aguardando consulta" : "Não vinculado";
  return <section className="panel settings-section slack-monitor-settings" aria-labelledby="slack-monitor-heading">
    <div className="settings-section-heading"><span className="settings-section-icon" aria-hidden="true">#</span><div><h3 id="slack-monitor-heading">Slack Web no seu computador</h3><p>O monitor local consulta as menções não lidas nos dois canais a cada cinco minutos, sem abrir as conversas nem marcá-las como lidas.</p></div></div>
    {!enabled && <p className="muted">Indisponível nesta demonstração.</p>}
    <p role="status" className="slack-monitor-state">Estado: {stateText}{status.last_scan ? ` · última consulta ${new Date(status.last_scan).toLocaleString("pt-BR")}` : ""}</p>
    {error && <p className="form-error" role="alert">{error} Se o monitor ainda não foi instalado, execute <code>slack-monitor/Install-Monitor.ps1</code> neste computador.</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="slack-monitor-form">
      <label><span>Link do canal brazil-tutors</span><Input type="url" required placeholder="Cole o link do canal no Slack Web" value={channels[0]} onChange={(event) => setChannels([event.target.value, channels[1]])} /></label>
      <label><span>Link do canal brazil-tutors-team-3</span><Input type="url" required placeholder="Cole o link do canal no Slack Web" value={channels[1]} onChange={(event) => setChannels([channels[0], event.target.value])} /></label>
      <label><span>Sua menção no Slack</span><Input required maxLength={100} placeholder="Nome que aparece quando mencionam você" value={mentionText} onChange={(event) => setMentionText(event.target.value)} /></label>
      <div className="form-actions"><Button type="button" className="button-ghost" onClick={() => void saveConfiguration()} disabled={busy || !mentionText || channels.some((channel) => !channel)}>Salvar configuração local</Button><Button type="button" className="button-ghost" onClick={() => void openSlackLogin()} disabled={busy}>Abrir Slack para login</Button>{connected ? <Button type="button" className="button-ghost" onClick={() => void disconnect()} disabled={busy}>Desvincular</Button> : <Button type="button" onClick={() => void pairMonitor()} disabled={busy || !mentionText || channels.some((channel) => !channel)}>Vincular monitor</Button>}</div>
    </div>
  </section>;
}
