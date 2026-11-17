"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { createSlackSettingsAdapter, type SlackSettingsAdapter } from "@/lib/slack-client";
import { SLACK_CONTEXT_LIMITATION, type SlackChannel, type SlackStatus } from "@/lib/slack-contract";
import styles from "./slack-settings.module.css";

export type { SlackSettingsAdapter } from "@/lib/slack-client";
const demoStatus: SlackStatus = { configured: false, connected: false, workspace: null, selectedChannels: [], limitations: [SLACK_CONTEXT_LIMITATION] };

type SlackSettingsProps = { adapter?: SlackSettingsAdapter; demo?: boolean; ownerUid?: string };
export function SlackSettings(props: SlackSettingsProps) {
  return <SlackSettingsContent key={props.ownerUid ?? "demo"} {...props} />;
}
function SlackSettingsContent({ adapter: customAdapter, demo = false, ownerUid = "" }: SlackSettingsProps) {
  const adapter = useMemo(() => customAdapter ?? createSlackSettingsAdapter(ownerUid), [customAdapter, ownerUid]);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [status, setStatus] = useState<SlackStatus | null>(demo ? demoStatus : null);
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [cursor, setCursor] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (demo) return;
    let active = true;
    void adapter.status().then((value) => {
      if (!active) return;
      setStatus(value); setSelected(value.selectedChannels.map((channel) => channel.id));
      setChannels(value.selectedChannels); setLoaded(false); setCursor(""); setError("");
      if (new URLSearchParams(window.location.search).get("slack") === "error") setError("A autorização Slack não foi concluída. Tente conectar novamente.");
    }).catch(() => { if (active) setError("Não foi possível carregar o status do Slack. Tente novamente."); });
    return () => { active = false; };
  }, [adapter, demo, retry]);

  async function perform(action: () => Promise<void>) {
    if (busy || demo) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível concluir a operação."); }
    finally { setBusy(false); }
  }
  function loadChannels() {
    void perform(async () => {
      const result = await adapter.channels(cursor);
      if (!mounted.current) return;
      setChannels((previous) => [...new Map([...previous, ...result.channels].map((channel) => [channel.id, channel])).values()]);
      setCursor(result.nextCursor); setLoaded(true);
    });
  }
  return <section className={`panel ${styles.panel}`} aria-labelledby="slack-settings-title" aria-busy={busy}>
    <h2 id="slack-settings-title">Slack</h2>
    <p>Conecte sua conta e escolha até cinco canais para fornecer contexto ao assistente. A consulta inclui mensagens e respostas em threads, dentro dos limites informados.</p>
    <p className="muted">A autorização permite leitura dos canais acessíveis à sua conta. O NexusClass consulta somente os canais que você selecionar abaixo.</p>
    {demo && <p role="status">A conexão Slack está disponível na conta autenticada. Esta demonstração usa dados locais.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!status && !error && <p role="status">Carregando integração…</p>}
    {!demo && <Button className="button-ghost" disabled={busy} onClick={() => setRetry((value) => value + 1)}>Atualizar status</Button>}
    {status && <>
      <p><strong>{status.connected ? `Conectado a ${status.workspace?.name ?? "Slack"}` : "Slack desconectado"}</strong></p>
      {!status.configured && !demo && <p>O administrador precisa configurar o OAuth Slack no servidor.</p>}
      {!status.connected && <Button disabled={busy || !status.configured || demo} onClick={() => void perform(async () => {
        const result = await adapter.connect();
        if (!mounted.current) return;
        const url = new URL(result.url);
        if (url.origin !== "https://slack.com" || url.pathname !== "/oauth/v2/authorize") throw new Error("Endereço de autorização inválido.");
        window.location.assign(url.toString());
      })}>Conectar Slack</Button>}
      {status.connected && <>
        <fieldset disabled={busy} className={styles.channels}>
          <legend>Canais autorizados para consulta</legend>
          <p>Selecione apenas os canais necessários. A lista mostra canais dos quais você participa.</p>
          {channels.map((channel) => <label key={channel.id} className={styles.channel}>
            <input type="checkbox" checked={selected.includes(channel.id)} disabled={!selected.includes(channel.id) && selected.length >= 5} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, channel.id] : previous.filter((id) => id !== channel.id))} />
            <span>#{channel.name}{channel.private ? " (privado)" : ""}</span>
          </label>)}
          {loaded && !channels.length && <p>Nenhum canal disponível. Confira sua participação no Slack.</p>}
          {(!loaded || cursor) && <Button className="button-ghost" onClick={loadChannels}>{loaded ? "Carregar mais canais" : "Listar canais"}</Button>}
          <Button onClick={() => void perform(async () => {
            const value = await adapter.select(selected);
            if (!mounted.current) return;
            setStatus(value);
            setSelected(value.selectedChannels.map((channel) => channel.id)); setNotice("Seleção de canais salva.");
          })}>Salvar canais selecionados</Button>
        </fieldset>
        <Button className="button-danger" disabled={busy} onClick={() => {
          if (!window.confirm("Desconectar o Slack e impedir novas consultas?")) return;
          void perform(async () => {
            const result = await adapter.disconnect();
            if (!mounted.current) return;
            setStatus({ ...status, connected: false, workspace: null, selectedChannels: [] }); setChannels([]); setSelected([]);
            setNotice(result.revocationPending ? "Leitura bloqueada. A revogação no Slack ficou pendente. Tente desconectar novamente." : "Slack desconectado e autorização revogada.");
          });
        }}>Desconectar Slack</Button>
      </>}
      {!status.connected && !demo && <Button className="button-ghost" disabled={busy} onClick={() => void perform(async () => {
        const result = await adapter.disconnect();
        if (!mounted.current) return;
        setNotice(result.revocationPending ? "A revogação continua pendente. Tente novamente mais tarde." : "Autorização anterior removida.");
      })}>Revogar autorização anterior</Button>}
      <ul className="muted">{status.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
    </>}
  </section>;
}

export function SlackSettingsPageContent({ ownerUid }: { ownerUid: string }) {
  return <><Link href="/settings">Voltar às configurações</Link><h1>Configurações do Slack</h1><SlackSettings ownerUid={ownerUid} /></>;
}
