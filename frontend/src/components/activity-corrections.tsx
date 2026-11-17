"use client";
import { useEffect, useRef, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import type { CorrectionRubric, CorrectionSuggestion } from "@/lib/correction-contract";
import { CORRECTION_BATCH_LIMIT } from "@/lib/correction-contract";
import { approveCorrection, suggestCorrection, rubricError, safeCorrectionUrl, CorrectionRequestError } from "@/lib/correction-client";
import type { ManualActivity } from "@/lib/manual-pedagogy";
import { subscribeToAuth } from "@/lib/firebase-auth";
import { getFirebaseAuth } from "@/lib/firebase";
import { CorrectionRubricEditor } from "./activity-corrections-rubric";
import { Modal } from "./modal";
import styles from "./activity-corrections.module.css";

export type CorrectionActivity = { key: string; id: string; source: "manual" | "kodland"; title: string; student: string; manual?: ManualActivity; correctionUrl?: string };
type Draft = { rubric: CorrectionRubric; statement: string; submission: string; complete: boolean; confirmed: boolean; result?: CorrectionSuggestion; score: string; feedback: string; state?: "saved" | "ready_to_send"; error?: string };
const initialRubric = (): CorrectionRubric => ({ guidance: "", max_score: 10, precision: 0, criteria: [{ id: "criterion_1", description: "", max_points: 10 }] });
const initialDraft = (activity: CorrectionActivity): Draft => ({ rubric: activity.manual?.grading_rubric ?? initialRubric(), statement: activity.manual?.description ?? "", submission: activity.manual?.submission_text ?? "", complete: activity.manual?.submission_complete === true, confirmed: false, score: "", feedback: "" });

/** Local deterministic demonstration, never invokes authentication or external services. */
export function demoCorrection(activity: CorrectionActivity, draft: Pick<Draft, "rubric">): CorrectionSuggestion {
  const rubric = draft.rubric;
  const criteria = rubric.criteria.map(c => ({ criterion_id: c.id, points: Math.floor(c.max_points * 0.6 * 10 ** rubric.precision) / 10 ** rubric.precision, justification: "Exemplo fictício: atende parcialmente ao critério.", evidence_refs: ["demo_submission"] }));
  return { suggestion_id: `demo_${activity.key}`, request_id: "demo", source: activity.source, activity_id: activity.id, status: "draft_ready", score: Number(criteria.reduce((sum, c) => sum + c.points, 0).toFixed(rubric.precision)), max_score: rubric.max_score, precision: rubric.precision, criteria, strengths: ["Exemplo de ponto positivo."], corrections: ["Exemplo de melhoria."], feedback: "Exemplo fictício: revise os critérios e explique melhor sua solução.", limitations: ["Roteiro determinístico local; não avalia o conteúdo com IA."], model: null, snapshot_hash: "demo", revision: activity.manual?.updated_at ?? "demo", context_provenance: activity.source === "manual" ? "server" : "tutor_provided", external_write_verified: false, created_at: "2026-11-17T12:00:00Z", expires_at: "2099-01-01T00:00:00Z" };
}

export function ActivityCorrections({ activities, demo = false, onPrepareManual, onSaveDemoManual, onManualApproved }: {
  activities: readonly CorrectionActivity[];
  demo?: boolean;
  onPrepareManual: (activity: ManualActivity) => Promise<ManualActivity>;
  onSaveDemoManual?: (activity: ManualActivity) => Promise<ManualActivity>;
  onManualApproved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [resumeAt, setResumeAt] = useState(0);
  const active = useRef<AbortController | null>(null);
  const [chosen, setChosen] = useState<Record<string, CorrectionActivity>>({});
  const owner = useRef<string | null | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const patch = (key: string, change: Partial<Draft>) => setDrafts(previous => ({ ...previous, [key]: { ...previous[key], ...change } }));
  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => {
    if (demo) return;
    owner.current = getFirebaseAuth().currentUser?.uid ?? null;
    return subscribeToAuth(user => {
      const uid = user?.id ?? null;
      if (owner.current === uid) return;
      owner.current = uid;
      active.current?.abort(); active.current = null;
      setChosen({}); setOpen(false); setSelected([]); setDrafts({}); setBusy(false); setMessage(""); setResumeAt(0);
    });
  }, [demo]);
  const close = () => { active.current?.abort(); active.current = null; setBusy(false); setOpen(false); trigger.current?.focus(); };
  const checkOwner = (controller: AbortController) => {
    controller.signal.throwIfAborted();
    if (!demo && (!owner.current || getFirebaseAuth().currentUser?.uid !== owner.current)) {
      controller.abort(); active.current = null; setChosen({}); setDrafts({}); setSelected([]); setOpen(false); setBusy(false);
      throw new Error("A conta mudou. Reabra as correções.");
    }
  };
  const valid = (activity: CorrectionActivity, draft: Draft) => !rubricError(draft.rubric) && draft.confirmed && draft.complete && Boolean((activity.source === "manual" ? activity.manual?.submission_text : draft.submission)?.trim()) && Boolean(draft.statement.trim());
  const generate = async () => {
    if (active.current) return;
    if (Date.now() < resumeAt) { setMessage("Limite temporário. Aguarde o prazo informado antes de continuar."); return; }
    const controller = new AbortController(); active.current = controller; setBusy(true); setMessage("");
    try {
      for (const key of selected) {
        const activity = activities.find(a => a.key === key); const draft = drafts[key];
        if (!activity || !draft || draft.result || !valid(activity, draft)) continue;
        try {
          checkOwner(controller);
          let revision = "tutor_context";
          if (activity.manual) {
            const prepared = await onPrepareManual({ ...activity.manual, grading_rubric: draft.rubric, submission_complete: draft.complete });
            if (active.current !== controller) return;
            checkOwner(controller);
            setChosen(current => ({ ...current, [key]: { ...activity, manual: prepared } }));
            revision = prepared.updated_at;
          }
          const result = demo ? demoCorrection(activity, draft) : await suggestCorrection({ source: activity.source, activity_id: activity.id, expected_revision: revision, request_id: crypto.randomUUID(), ...(activity.source === "kodland" ? { manual_context: { provenance: "tutor_provided", statement: draft.statement.trim(), submission_text: draft.submission.trim(), submission_complete: draft.complete, rubric: draft.rubric, rubric_confirmed: true, delivery_state: "TASK_SUBMITTED", human_review_applicable: true, ...(safeCorrectionUrl(activity.correctionUrl) ? { correction_url: safeCorrectionUrl(activity.correctionUrl)! } : {}) } } : {}) }, controller.signal);
          if (active.current !== controller) return;
          patch(key, { result, score: result.score === null ? "" : String(result.score), feedback: result.feedback, error: "" });
        } catch (reason) {
          if (active.current !== controller) return;
          patch(key, { error: reason instanceof Error ? reason.message : "Falha na geração." });
          if (reason instanceof CorrectionRequestError && reason.status === 429) {
            const until = Date.now() + Math.max(1, reason.retryAfter) * 1000;
            setResumeAt(until); setMessage(`Fila pausada por limite de uso. Continue após ${new Date(until).toLocaleTimeString("pt-BR")}. Sugestões anteriores preservadas.`); break;
          }
        }
      }
    } finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  const approve = async (activity: CorrectionActivity, draft: Draft) => {
    if (active.current || !draft.result) return;
    const controller = new AbortController(); active.current = controller; setBusy(true);
    try {
      checkOwner(controller);
      let state: "saved" | "ready_to_send";
      if (demo) {
        if (activity.manual) {
          if (!onSaveDemoManual) throw new Error("Gravação demonstrativa indisponível.");
          const prepared = chosen[activity.key]?.manual ?? activity.manual;
          await onSaveDemoManual({ ...prepared, grading_rubric: draft.rubric, submission_complete: draft.complete, score: Number(draft.score), max_score: draft.result.max_score!, feedback: draft.feedback.trim(), status: "corrected", correction_origin: "assistant_approved", correction_suggestion_id: draft.result.suggestion_id, corrected_at: new Date().toISOString() });
        }
        state = activity.source === "manual" ? "saved" : "ready_to_send";
      } else {
        const approval = await approveCorrection({ suggestion_id: draft.result.suggestion_id, snapshot_hash: draft.result.snapshot_hash, score: Number(draft.score), feedback: draft.feedback.trim(), request_id: crypto.randomUUID() }, controller.signal);
        if (approval.activity_id !== activity.id || approval.status !== (activity.source === "manual" ? "saved" : "ready_to_send")) throw new Error("Aprovação não corresponde à atividade.");
        state = approval.status;
      }
      if (active.current !== controller) return;
      patch(activity.key, { state, error: "" });
      if (state === "saved" && !demo) {
        try { await onManualApproved(); } catch { if (active.current === controller) setMessage("Correção salva. Reabra a página para atualizar a lista."); }
      }
    } catch (reason) { if (active.current === controller) patch(activity.key, { error: reason instanceof Error ? reason.message : "Falha ao aprovar." }); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  };
  return <>
    <button ref={trigger} type="button" className={`button button-ghost symbol-action ${styles.trigger}`} aria-label="Abrir correção assistida" title="Correção assistida" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><ClipboardCheck size={18} aria-hidden="true" /></button>
    <Modal open={open} title="Correção assistida" onClose={close} className={styles.modal}>
      <p>{demo ? "Demonstração local com sugestões fictícias determinísticas. Nenhuma consulta externa." : "A IA pode errar. Revise cada sugestão antes de aprovar. O Slack não participa da nota."}</p>
      <p>Selecione até 5 entregas pendentes. A geração é sequencial; nenhuma nota é aprovada automaticamente.</p>
      <div className={styles.queue} aria-busy={busy}>
        {activities.filter(a => !drafts[a.key]?.state).map(activity => <label key={activity.key} className={styles.choice}><input type="checkbox" disabled={busy || (!selected.includes(activity.key) && selected.length >= CORRECTION_BATCH_LIMIT)} checked={selected.includes(activity.key)} onChange={e => {
          setSelected(current => e.target.checked ? [...current, activity.key] : current.filter(key => key !== activity.key));
          setChosen(current => ({ ...current, [activity.key]: activity }));
          if (!drafts[activity.key]) patch(activity.key, initialDraft(activity));
        }} />{activity.student} — {activity.title} ({activity.source === "manual" ? "Própria" : "Kodland"})</label>)}
        {!activities.length && <p>Nenhuma entrega pendente disponível.</p>}
        <p role="status">{selected.length}/5 selecionadas. {busy ? "Processando uma atividade por vez…" : message}</p>
        {selected.map(key => {
          const activity = activities.find(a => a.key === key) ?? chosen[key]; const draft = drafts[key];
          if (!activity || !draft) return null;
          const result = draft.result;
          const score = draft.score.trim() ? Number(draft.score) : NaN;
          const precision = result?.precision ?? 0;
          const scoreValid = Number.isFinite(score) && score >= 0 && score <= (result?.max_score ?? -1) && Math.abs(score * 10 ** precision - Math.round(score * 10 ** precision)) < 1e-7;
          const url = safeCorrectionUrl(activity.correctionUrl);
          return <section key={key} className={styles.item} aria-label={`Correção de ${activity.title}`}>
            <h3>{activity.student} — {activity.title}</h3>
            {draft.state ? <><p role="status">{draft.state === "saved" ? "Correção salva." : "Revisão aprovada para copiar. Nenhum envio à Kodland foi realizado."}</p>{draft.state === "ready_to_send" && <div className={styles.actions}><button type="button" className="button" onClick={async () => { try { await navigator.clipboard.writeText(`Nota: ${draft.score}/${result?.max_score}\n${draft.feedback}`); patch(key, { error: "" }); setMessage("Correção copiada. Cole e confira na Kodland."); } catch { patch(key, { error: "Não foi possível copiar. Selecione o texto abaixo." }); } }}>Copiar correção</button>{url && <a className="button button-ghost" href={url} target="_blank" rel="noreferrer">Abrir Kodland</a>}<p className={styles.text}>{draft.score}/{result?.max_score} — {draft.feedback}</p></div>}</> : !result ? <>
              {activity.source === "kodland" ? <><p>Contingência: enunciado e texto da entrega colados pelo tutor. Não houve leitura verificada na Kodland. Confirme na plataforma que a entrega aguarda correção humana.</p><label className="field">Enunciado<textarea className="input" value={draft.statement} maxLength={16000} disabled={busy} onChange={e => patch(key, { statement: e.target.value })} /></label><label className="field">Texto da entrega colado pelo tutor<textarea className="input" value={draft.submission} maxLength={30000} disabled={busy} onChange={e => patch(key, { submission: e.target.value })} /></label></> : <><p>Entrega própria: o servidor relê o texto salvo antes de gerar a sugestão. Links isolados não substituem o texto.</p><p className={styles.text}>{activity.manual?.submission_text || "Sem texto da entrega. Complete a atividade antes de continuar."}</p></>}
              <CorrectionRubricEditor value={draft.rubric} disabled={busy} onChange={rubric => patch(key, { rubric })} />
              {rubricError(draft.rubric) && <p>{rubricError(draft.rubric)}</p>}
              <label className={styles.choice}><input type="checkbox" checked={draft.complete} disabled={busy} onChange={e => patch(key, { complete: e.target.checked })} />Confirmo que o texto contém a entrega completa</label>
              <label className={styles.choice}><input type="checkbox" checked={draft.confirmed} disabled={busy} onChange={e => patch(key, { confirmed: e.target.checked })} />Confirmo a rubrica e que a atividade aguarda correção humana</label>
            </> : <>
              <p>Estado: {result.status === "draft_ready" ? "Sugestão aguardando revisão" : result.status === "stale" ? "Contexto desatualizado; gere novamente" : "Contexto insuficiente; confira a entrega"}</p>
              {result.criteria.map(c => <p key={c.criterion_id}><strong>{draft.rubric.criteria.find(r => r.id === c.criterion_id)?.description || c.criterion_id}: {c.points}</strong> — {c.justification}</p>)}
              {result.strengths?.map((s, i) => <p key={`s${i}`}>Ponto positivo: {s}</p>)}{result.corrections?.map((s, i) => <p key={`c${i}`}>Melhoria: {s}</p>)}
              {result.limitations.map((s, i) => <p key={i}>{s}</p>)}
              {result.status === "draft_ready" && <><label className="field">Pontos revisados<input className="input" type="number" min={0} max={result.max_score!} step={10 ** -precision} value={draft.score} disabled={busy} onChange={e => patch(key, { score: e.target.value })} /></label><p>Máximo {result.max_score}; precisão {precision} casas decimais.</p><label className="field">Feedback revisado<textarea className="input" maxLength={8000} value={draft.feedback} disabled={busy} onChange={e => patch(key, { feedback: e.target.value })} /></label><button type="button" className="button" disabled={busy || !scoreValid || !draft.feedback.trim()} onClick={() => void approve(activity, draft)}>{activity.source === "manual" ? "Aprovar e salvar atividade" : "Aprovar para copiar"}</button></>}
              <button type="button" className="button button-ghost" disabled={busy} onClick={() => patch(key, { result: undefined, score: "", feedback: "", error: "" })}>Descartar sugestão e revisar contexto</button>
            </>}
            {draft.error && <p role="alert" className="form-error">{draft.error}</p>}
          </section>;
        })}
        <button type="button" className="button" disabled={busy || !selected.length || selected.some(key => { const activity = activities.find(a => a.key === key) ?? chosen[key]; return !activity || (!drafts[key]?.result && !valid(activity, drafts[key])); }) || selected.every(key => drafts[key]?.result)} onClick={() => void generate()}>Gerar sugestões selecionadas</button>
      </div>
    </Modal>
  </>;
}
