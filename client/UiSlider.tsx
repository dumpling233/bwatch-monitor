import React, { useId, useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import './ui-slider.css';

export type UiSliderMark = { value: number; label?: string };
export interface UiSliderProps {
  label: ReactNode;
  ariaLabel?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  step?: number | 'any';
  marks?: readonly UiSliderMark[];
  snapToMarks?: boolean;
  formatValue?: (value: number) => ReactNode;
  layout?: 'stacked' | 'inline';
  className?: string;
  disabled?: boolean;
}

export function UiSlider({ label, ariaLabel, value, min, max, onChange, step = 1, marks = [], snapToMarks = false,
  formatValue, layout = 'stacked', className = '', disabled = false }: UiSliderProps) {
  const id = useId();
  const lower = Number.isFinite(min) ? min : 0;
  const upper = Number.isFinite(max) && max > lower ? max : lower + 1;
  const stops = useMemo(() => [...new Map(marks.filter(mark => Number.isFinite(mark.value) && mark.value >= lower && mark.value <= upper)
    .map(mark => [mark.value, mark])).values()].sort((a, b) => a.value - b.value), [marks, lower, upper]);
  const snapped = snapToMarks && stops.length > 0;
  const increment = typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : (upper - lower) / 100;
  const clamp = (next: number) => Math.max(lower, Math.min(upper, Number.isFinite(next) ? next : lower));
  const normalize = (next: number) => {
    const bounded = clamp(next);
    if (snapped) return stops.reduce((nearest, mark) => Math.abs(mark.value - bounded) < Math.abs(nearest - bounded) ? mark.value : nearest, stops[0].value);
    if (step === 'any') return bounded;
    const maximumStep = Math.floor(Number(((upper - lower) / increment).toPrecision(12)));
    const nearestStep = Math.max(0, Math.min(maximumStep, Math.round((bounded - lower) / increment)));
    return clamp(Number((lower + nearestStep * increment).toPrecision(12)));
  };
  const current = normalize(value);
  const output = formatValue ? formatValue(current) : current;
  const valueText = typeof output === 'string' || typeof output === 'number' ? String(output) : String(current);
  const publish = (next: number) => {
    const normalized = normalize(Number(next.toPrecision(12)));
    if (normalized !== current) onChange(normalized);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = ['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key) ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    if (event.key === 'Home') { publish(snapped ? stops[0].value : lower); return; }
    if (event.key === 'End') { publish(snapped ? stops[stops.length - 1].value : upper); return; }
    const page = event.key === 'PageUp' || event.key === 'PageDown';
    if (snapped) {
      const index = stops.findIndex(mark => mark.value === current);
      const nextIndex = Math.max(0, Math.min(stops.length - 1, index + direction * (page ? Math.max(1, Math.ceil((stops.length - 1) / 10)) : 1)));
      publish(stops[nextIndex].value);
    } else publish(current + direction * increment * (page ? 10 : 1));
  };
  return <div className={`ui-slider ${className}`.trim()} data-layout={layout} data-disabled={disabled || undefined}
    style={{ '--ui-slider-progress': `${(current - lower) / (upper - lower) * 100}%` } as CSSProperties}>
    <label className="ui-slider-label" id={`${id}-label`} htmlFor={id}>{label}</label>
    <div className="ui-slider-control">
      <div className="ui-slider-track" aria-hidden="true"><span className="ui-slider-fill" />{stops.map(mark => <span key={mark.value}
        className="ui-slider-mark" data-active={mark.value <= current} style={{ left: `${(mark.value - lower) / (upper - lower) * 100}%` }} />)}</div>
      <input id={id} className="ui-slider-input" type="range" min={lower} max={upper} value={current}
        step={snapped || step === 'any' ? 'any' : increment} disabled={disabled}
        aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : `${id}-label`} aria-valuetext={valueText}
        onChange={event => publish(Number(event.currentTarget.value))} onKeyDown={handleKeyDown} />
      {stops.some(mark => mark.label) && <div className="ui-slider-mark-labels" aria-hidden="true">{stops.map(mark => mark.label && <span key={mark.value}
        style={{ left: `${(mark.value - lower) / (upper - lower) * 100}%` }} data-edge={mark.value === lower ? 'start' : mark.value === upper ? 'end' : undefined}>{mark.label}</span>)}</div>}
    </div>
    <output className="ui-slider-value" htmlFor={id} aria-live="off">{output}</output>
  </div>;
}
