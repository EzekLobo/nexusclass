"use client";
import type { CorrectionRubric } from "@/lib/correction-contract";

export function CorrectionRubricEditor({ value, onChange, disabled = false }: { value: CorrectionRubric; onChange: (value: CorrectionRubric) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled} style={{ minWidth: 0, display: "grid", gap: 12 }}>
    <legend>Rubrica da atividade</legend>
    <label className="field">Orientações da rubrica<textarea className="input" required maxLength={5000} value={value.guidance} onChange={e => onChange({ ...value, guidance: e.target.value })} /></label>
    <label className="field">Nota máxima<input className="input" type="number" min="0.001" step="any" value={value.max_score} onChange={e => onChange({ ...value, max_score: Number(e.target.value) })} /></label>
    <label className="field">Precisão decimal<select className="input" value={value.precision} onChange={e => onChange({ ...value, precision: Number(e.target.value) })}>{[0, 1, 2, 3].map(n => <option key={n} value={n}>{n} casas decimais</option>)}</select></label>
    {value.criteria.map((criterion, index) => <div key={criterion.id} style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <label className="field">Critério {index + 1}<textarea className="input" required maxLength={1000} value={criterion.description} onChange={e => onChange({ ...value, criteria: value.criteria.map(c => c.id === criterion.id ? { ...c, description: e.target.value } : c) })} /></label>
      <label className="field">Máximo do critério {index + 1}<input className="input" type="number" min="0.001" step="any" value={criterion.max_points} onChange={e => onChange({ ...value, criteria: value.criteria.map(c => c.id === criterion.id ? { ...c, max_points: Number(e.target.value) } : c) })} /></label>
      <button type="button" className="button button-ghost" disabled={value.criteria.length <= 1} onClick={() => onChange({ ...value, criteria: value.criteria.filter(c => c.id !== criterion.id) })}>Remover critério {index + 1}</button>
    </div>)}
    <button type="button" className="button button-ghost" disabled={value.criteria.length >= 20} onClick={() => onChange({ ...value, criteria: [...value.criteria, { id: crypto.randomUUID(), description: "", max_points: 0 }] })}>Adicionar critério</button>
  </fieldset>;
}
