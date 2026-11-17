"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import type { AssistantAnswer, AssistantAskInput } from "@/lib/assistant-contract";
import { askAssistant, assistantSourceHref } from "@/lib/assistant-client";
import { subscribeToAuth } from "@/lib/firebase-auth";
import { Modal } from "./modal";
import { Button } from "./ui";
import styles from "./activity-assistant.module.css";

export type AssistantActivityOption = {
  id: string;
  title: string;
  groupId: string;
  groupName: string;
  studentId: string;
  studentName: string;
  lessonId: string;
  lessonName: string;
};

const filterFields = [
  ["group_id", "Turma", "groupId", "groupName"],
  ["student_id", "Aluno", "studentId", "studentName"],
  ["lesson_id", "Aula", "lessonId", "lessonName"],
  ["activity_id", "Atividade", "id", "title"],
] as const;
type Filters = Pick<AssistantAskInput, "group_id" | "student_id" | "lesson_id" | "activity_id">;
type DisplayAnswer = { value: AssistantAnswer; consultedAt: string };

export function AssistantAnswerView({ result, demo = false }: { result: DisplayAnswer; demo?: boolean }) {
  return <section className={styles.answer} aria-label="Resposta do assistente" tabIndex={-1}>
    <h3>{result.value.insufficient_context ? "Contexto insuficiente" : "Resposta"}</h3>
    <p className={styles.text}>{result.value.answer}</p>
    {(["activity", "slack"] as const).map(kind => {
      const sources = result.value.sources.filter(source => source.source === kind);
      return sources.length > 0 && <div key={kind}>
        <h4>{kind === "activity" ? "Fontes de atividades" : "Fontes do Slack"}</h4>
        <ul>{sources.map(source => {
          const href = demo && source.source === "activity" ? "/demo#classes" : assistantSourceHref(source);
          return <li key={source.ref}>{href ? <a href={href}>{source.label}</a> : <span>{source.label}</span>}</li>;
        })}</ul>
      </div>;
    })}
    {result.value.limitations.length > 0 && <div><h4>Limitações da consulta</h4><ul>{result.value.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    <p className="muted">Consulta recebida em <time dateTime={result.consultedAt}>{new Date(result.consultedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</time> (Brasília). A IA pode errar. Confira as fontes antes de decidir.</p>
  </section>;
}

export function ActivityAssistant({ activities, demo = false }: { activities: readonly AssistantActivityOption[]; demo?: boolean }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [includeSlack, setIncludeSlack] = useState(false);
  const [filters, setFilters] = useState<Filters>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState("");
  const [result, setResult] = useState<DisplayAnswer | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const answerContainer = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => () => { activeRequest.current?.abort(); }, []);
  useEffect(() => {
    if (demo) return;
    let owner: string | null | undefined;
    return subscribeToAuth(user => {
      const uid = user?.id ?? null;
      if (owner === undefined) { owner = uid; return; }
      if (owner === uid) return;
      owner = uid;
      activeRequest.current?.abort();
      activeRequest.current = null;
      setResult(null);
      setQuestion("");
      setFilters({});
      setIncludeSlack(false);
      setError("");
      setRequestId("");
      setBusy(false);
      setOpen(false);
    });
  }, [demo]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const target = result ? answerContainer.current?.querySelector<HTMLElement>("section") : questionInput.current;
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [result, open]);

  const close = () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setBusy(false);
    setOpen(false);
    trigger.current?.focus();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeRequest.current || !question.trim()) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const request_id = crypto.randomUUID();
    setRequestId(request_id);
    setBusy(true);
    setError("");
    const input: AssistantAskInput = { question: question.trim(), request_id, include_slack: includeSlack, ...filters };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("A consulta demorou além do esperado. Tente novamente."));
          controller.abort();
        }, 55000);
      });
      const answer = demo ? {
        request_id,
        answer: "Exemplo fictício de acompanhamento. Uma atividade entregue aguarda correção. Uma atividade corrigida já foi avaliada. Quando a situação é desconhecida ou sem avaliação, é preciso conferir a fonte para concluir sobre a entrega.",
        insufficient_context: false,
        sources: [{ source: "activity" as const, ref: "demo_activity", label: "Roteiro demonstrativo de atividades", href: "/classes?tab=activities" }],
        limitations: ["Resposta de exemplo gerada localmente com dados fictícios.", ...(includeSlack ? ["O Slack está simulado nesta demonstração. Nenhuma mensagem foi consultada."] : [])],
      } : await Promise.race([askAssistant(input, controller.signal), deadline]);
      if (activeRequest.current !== controller) return;
      setResult({ value: answer, consultedAt: new Date().toISOString() });
    } catch (reason) {
      if (activeRequest.current === controller) setError(reason instanceof Error ? reason.message : "Não foi possível consultar o assistente. Tente novamente.");
    } finally {
      clearTimeout(timer);
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  };

  return <>
    <button ref={trigger} type="button" className={`button button-ghost symbol-action ${styles.trigger}`} aria-label="Abrir assistente de atividades" title="Assistente de atividades" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Sparkles size={18} aria-hidden="true" /></button>
    <Modal open={open} title="Assistente de atividades" onClose={close} className={styles.modal}>
      <p className="muted">{demo ? "Demonstração com roteiro fictício local, sem consultas externas." : "Consulta os registros disponíveis no servidor. Atividades mantidas apenas no navegador podem estar indisponíveis."}</p>
      <form className="form" onSubmit={submit} aria-busy={busy}>
        <fieldset disabled={busy} className={styles.fields}>
          <legend className={styles.legend}>Contexto da pergunta</legend>
          <div className={styles.filters}>
            {filterFields.map(([field, label, valueKey, labelKey], index) => {
              const scoped = activities.filter(activity => filterFields.slice(0, index).every(([parent, , parentKey]) => !filters[parent] || activity[parentKey] === filters[parent]));
              const options = [...new Map(scoped.filter(activity => activity[valueKey]).map(activity => [activity[valueKey], activity[labelKey] || activity[valueKey]])).entries()];
              return <label key={field} className="field" htmlFor={`${id}-${field}`}>{label}<select id={`${id}-${field}`} className="input" value={filters[field] ?? ""} onChange={event => {
                const next = { ...filters };
                for (const [child] of filterFields.slice(index)) delete next[child];
                if (event.target.value) next[field] = event.target.value;
                setFilters(next);
              }}><option value="">Todos</option>{options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>;
            })}
          </div>
          <label className="field" htmlFor={`${id}-question`}>Pergunta<textarea ref={questionInput} id={`${id}-question`} className={`input ${styles.question}`} required maxLength={2000} rows={4} value={question} onChange={event => setQuestion(event.target.value)} placeholder="Quais atividades precisam de acompanhamento?" aria-describedby={`${id}-question-help`} /></label>
          <p id={`${id}-question-help`} className="muted">Até 2.000 caracteres. Evite incluir contatos ou credenciais.</p>
          <label className={styles.slack}><input type="checkbox" checked={includeSlack} onChange={event => setIncludeSlack(event.target.checked)} />Incluir Slack</label>
          <p className="muted">{demo ? "Slack simulado neste roteiro." : "Usa os canais autorizados em Configurações. A resposta informa quando essa fonte estiver indisponível."} {!demo && <a href="/settings/slack">Configurar Slack</a>}</p>
        </fieldset>
        <div className="form-actions"><Button type="submit" disabled={busy || !question.trim()}>{busy ? "Consultando…" : error ? "Tentar novamente" : "Perguntar"}</Button></div>
        <p role="status" aria-live="polite" className={styles.request}>{busy ? "Consultando fontes… " : result ? "Resposta disponível. " : ""}{requestId && <>Referência {requestId}</>}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
      <div ref={answerContainer}>{result && <AssistantAnswerView result={result} demo={demo} />}</div>
    </Modal>
  </>;
}
