import { useEffect, useState } from 'react';
import type { SceneObject } from '../types/project';
import type { ObjectPatch } from '../engine/Engine';
import { OPTIONS } from '../types/building';
import type { BuildingParams } from '../types/building';

const fmt = (units: number, factor: number) => String(Math.round((units / factor) * 100) / 100);

/** factor: 10 — метры (1 ед. = 10 см), 1 — безразмерное значение (этажи) */
function NumField({ label, value, factor = 10, unit = 'м', onCommit }: {
  label: string; value: number; factor?: number; unit?: string; onCommit: (units: number) => void;
}) {
  const [text, setText] = useState(fmt(value, factor));
  useEffect(() => setText(fmt(value, factor)), [value, factor]);
  const commit = () => {
    const n = parseFloat(text.replace(',', '.'));
    if (Number.isFinite(n)) onCommit(n * factor);
    else setText(fmt(value, factor));
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
      <em>{unit}</em>
    </label>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="wide" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function Inspector({ sel, onChange }: { sel: SceneObject | null; onChange: (p: ObjectPatch) => void }) {
  const [name, setName] = useState(sel?.name ?? '');
  useEffect(() => setName(sel?.name ?? ''), [sel?.id, sel?.name]);
  if (!sel) return <p className="muted">Ничего не выбрано. Выберите объект или нарисуйте здание.</p>;

  const b = sel.building;
  const bp = (patch: Partial<BuildingParams>) => onChange({ building: patch });

  return (
    <div>
      <label className="field">
        <span>Имя</span>
        <input
          className="wide"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => onChange({ name })}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>
      <NumField label="X" value={sel.x} onCommit={(v) => onChange({ x: v })} />
      <NumField label="Y" value={sel.y} onCommit={(v) => onChange({ y: v })} />
      <NumField label="Ширина" value={sel.w} onCommit={(v) => onChange({ w: v })} />
      <NumField label="Высота" value={sel.h} onCommit={(v) => onChange({ h: v })} />

      {b && (
        <>
          <h3>Здание</h3>
          <NumField label="Этажи" value={b.floors} factor={1} unit="" onCommit={(v) => bp({ floors: v })} />
          <NumField label="Выс. этажа" value={b.floorHeight} onCommit={(v) => bp({ floorHeight: v })} />
          <NumField label="Шаг окон" value={b.bayWidth} onCommit={(v) => bp({ bayWidth: v })} />
          <NumField label="Глубина" value={b.depth} onCommit={(v) => bp({ depth: v })} />
          <SelectField label="Фасад" value={b.facade} options={OPTIONS.facade} onChange={(v) => bp({ facade: v })} />
          <SelectField label="Крыша" value={b.roof} options={OPTIONS.roof} onChange={(v) => bp({ roof: v })} />
          <SelectField label="Дверь" value={b.door} options={OPTIONS.door} onChange={(v) => bp({ door: v })} />
          <SelectField label="Место двери" value={b.doorPos} options={OPTIONS.doorPos} onChange={(v) => bp({ doorPos: v })} />
          <SelectField label="Материал" value={b.material} options={OPTIONS.material} onChange={(v) => bp({ material: v })} />
          <label className="field">
            <span>Балконы</span>
            <input type="checkbox" className="check" checked={b.balconies} onChange={(e) => bp({ balconies: e.target.checked })} />
          </label>
        </>
      )}
    </div>
  );
}
