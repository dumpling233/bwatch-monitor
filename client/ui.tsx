import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Select from '@radix-ui/react-select';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Popover from '@radix-ui/react-popover';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleHelp, LoaderCircle, X } from 'lucide-react';
import { DateTime } from 'luxon';
import { useModalFocus, useModalLayer } from './modalLayer';
export { UiSlider, type UiSliderProps, type UiSliderMark } from './UiSlider';

const emptyValue = '__bwatch_empty__';
const ModalContext = createContext(false);

/** Preserve Radix's outside-click behavior, but never scroll the page when
 * returning focus after a selection, Escape, or an animated close. */
export const UiPopoverContent = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof Popover.Content> & {
  returnFocusRef: React.RefObject<HTMLElement | null>;
}>(function UiPopoverContent({ returnFocusRef, onOpenAutoFocus, onCloseAutoFocus, onInteractOutside, ...props }, ref) {
  const interactedOutside = useRef(false);
  return <Popover.Content {...props} ref={ref}
    onOpenAutoFocus={event => { interactedOutside.current = false; onOpenAutoFocus?.(event); }}
    onInteractOutside={event => {
      onInteractOutside?.(event);
      if (!event.defaultPrevented) interactedOutside.current = true;
    }}
    onCloseAutoFocus={event => {
      onCloseAutoFocus?.(event);
      if (!event.defaultPrevented) {
        event.preventDefault();
        if (!interactedOutside.current) returnFocusRef.current?.focus({ preventScroll: true });
      }
      interactedOutside.current = false;
    }} />;
});

/** Compact accessible help popover used for control-specific explanations. */
export function InfoPopover({ label = '查看说明', children }: { label?: string; children: React.ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => cancelClose(), []);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button ref={triggerRef} type="button" className="info-popover-trigger" aria-label={label}
        onPointerEnter={event => { if (event.pointerType === 'mouse') { cancelClose(); setOpen(true); } }}
        onPointerLeave={event => { if (event.pointerType === 'mouse' && !event.currentTarget.matches(':focus-visible')) scheduleClose(); }}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) { cancelClose(); setOpen(true); } }}
      ><CircleHelp size={16} aria-hidden="true" /></button>
    </Popover.Trigger>
    <Popover.Portal>
      <UiPopoverContent returnFocusRef={triggerRef} className="info-popover-content" side="top" sideOffset={8} collisionPadding={10}
        aria-label={label}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onPointerEnter={event => { if (event.pointerType === 'mouse') cancelClose(); }}
        onPointerLeave={event => { if (event.pointerType === 'mouse') scheduleClose(); }}
      >{children}</UiPopoverContent>
    </Popover.Portal>
  </Popover.Root>;
}

type ActionButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  busyLabel?: React.ReactNode;
  busyIcon?: React.ReactNode;
};

export const ActionButton = React.forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton({
  busy = false,
  busyLabel = '加载中…',
  busyIcon,
  className = '',
  disabled = false,
  children,
  type = 'button',
  ...props
}, ref) {
  return <button
    ref={ref}
    {...props}
    type={type}
    className={`action-button ${className}`.trim()}
    aria-busy={busy ? 'true' : 'false'}
    disabled={disabled || busy}
  >
    {busy ? <><span className="button-busy-icon" aria-hidden="true">{busyIcon ?? <LoaderCircle size={16} className="spin" />}</span><span>{busyLabel}</span></> : children}
  </button>;
});

/** Mount on demand, then retain content only until its closing transition ends. */
export function AnimatedCollapse({ open, children, className = '' }: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [present, setPresent] = useState(open);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const initializedRef = useRef(false);

  useLayoutEffect(() => { if (open) setPresent(true); }, [open]);
  useLayoutEffect(() => {
    const animate = initializedRef.current;
    initializedRef.current = true;
    const element = containerRef.current;
    if (!present || !element) return;

    // Read the in-flight position before cancelling so a rapid reversal stays continuous.
    const fromHeight = element.getBoundingClientRect().height;
    const fromOpacity = getComputedStyle(element).opacity;
    animationRef.current?.cancel();
    animationRef.current = null;
    const toHeight = open ? element.scrollHeight : 0;
    element.style.height = open ? 'auto' : '0px';
    element.style.opacity = open ? '1' : '0';
    delete element.dataset.animating;

    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !element.animate || fromHeight === toHeight) {
      if (!open) setPresent(false);
      return;
    }
    element.dataset.animating = 'true';
    const animation = element.animate([
      { height: `${fromHeight}px`, opacity: fromOpacity },
      { height: `${toHeight}px`, opacity: open ? '1' : '0' }
    ], { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    animationRef.current = animation;
    animation.onfinish = () => {
      animationRef.current = null;
      delete element.dataset.animating;
      if (!open) setPresent(false);
    };
  }, [open, present]);
  useLayoutEffect(() => () => { animationRef.current?.cancel(); }, []);

  return <div ref={containerRef} className={`animated-collapse ${className}`.trim()}
    hidden={!present} data-state={open ? 'open' : 'closed'} aria-hidden={!open} inert={!open}>
    {present && children}
  </div>;
}

function rollingNumberText(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('zh-CN');
}

function RollingDigit({ from, to, token }: { from: string; to: string; token: number }) {
  const fromValue = Number(from);
  const toValue = Number(to);
  const changed = fromValue !== toValue;
  const [settled, setSettled] = useState(!changed);
  useEffect(() => {
    if (!changed) return undefined;
    const frame = window.requestAnimationFrame(() => setSettled(true));
    return () => window.cancelAnimationFrame(frame);
  }, [changed, token]);
  return <span className="rolling-number-digit" aria-hidden="true">
    <span className={`rolling-number-track ${changed ? 'is-rolling' : ''}`} style={{ transform: `translateY(-${(settled ? toValue : fromValue) * 10}%)` }}>
      {Array.from({ length: 10 }, (_, digit) => <span key={digit}>{digit}</span>)}
    </span>
  </span>;
}

/** A compact odometer-style number that rolls each changed digit into place. */
export function RollingNumber({ value, className = '' }: { value: number | string | null | undefined; className?: string }) {
  const nextText = rollingNumberText(value);
  const previousTextRef = useRef(nextText);
  const [transition, setTransition] = useState({ from: nextText, to: nextText, token: 0 });
  useEffect(() => {
    if (nextText === previousTextRef.current) return;
    const from = previousTextRef.current;
    previousTextRef.current = nextText;
    setTransition(current => ({ from, to: nextText, token: current.token + 1 }));
  }, [nextText]);

  const targetDigits = transition.to.replace(/\D/g, '');
  const sourceDigits = transition.from.replace(/\D/g, '').padStart(targetDigits.length, '0').slice(-targetDigits.length);
  let digitIndex = 0;
  const content = targetDigits.length === 0
    ? transition.to
    : Array.from(transition.to).map((character, index) => {
      if (!/\d/.test(character)) return <span className="rolling-number-static" key={`separator:${index}`}>{character}</span>;
      const source = sourceDigits[digitIndex] ?? '0';
      digitIndex += 1;
      return <RollingDigit key={`digit:${index}:${transition.token}`} from={source} to={character} token={transition.token} />;
    });
  return <span className={`rolling-number ${className}`.trim()} role="status" aria-live="polite" aria-atomic="true" aria-label={transition.to}><span aria-hidden="true">{content}</span></span>;
}

/** Shared shell for informational dialogs, including the feature guide and releases. */
export function InfoDialog({ open, onClose, title, description, icon, children, footerNote, actions, className = '', closeDisabled = false, initialFocusRef, suspended = false }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  footerNote?: React.ReactNode;
  actions: React.ReactNode;
  className?: string;
  closeDisabled?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  suspended?: boolean;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useModalLayer(open, dialogRef, suspended);
  useModalFocus(open, dialogRef, initialFocusRef ?? headingRef, onClose, suspended, closeDisabled);
  if (!open) return null;
  return createPortal(<div className="ui-modal-layer info-dialog-overlay feature-guide-overlay" aria-hidden={suspended || undefined} inert={suspended} style={suspended ? { visibility: 'hidden', pointerEvents: 'none' } : undefined} onClick={event => {
    if (event.target === event.currentTarget && !closeDisabled) onClose();
  }}>
    <ModalContext.Provider value={true}><section ref={dialogRef} className={`info-dialog feature-guide ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      <header className="feature-guide-header">
        <div className="feature-guide-heading"><span className="feature-guide-icon" aria-hidden="true">{icon}</span><div>
          <h2 ref={headingRef} id={`${id}-title`} tabIndex={-1}>{title}</h2><p id={`${id}-description`}>{description}</p>
        </div></div>
        <ActionButton className="icon feature-guide-close" title={`关闭${title}`} aria-label={`关闭${title}`} onClick={onClose} disabled={closeDisabled}><X size={19} /></ActionButton>
      </header>
      <div className="feature-guide-body">{children}</div>
      <footer className="feature-guide-footer">{footerNote && <span>{footerNote}</span>}<div className="feature-guide-footer-actions">{actions}</div></footer>
    </section></ModalContext.Provider>
  </div>, document.body);
}

type SegmentedOption<T extends string | number> = {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
  className?: string;
};

export function SegmentedControl<T extends string | number>({
  value,
  defaultValue,
  options,
  onChange,
  label,
  className = '',
  dataTour,
  allowEmptySelection = false,
  disabled = false,
}: {
  value: T;
  /** Business default; must belong to options and is always rendered first. */
  defaultValue: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  dataTour?: string;
  allowEmptySelection?: boolean;
  disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const [ready, setReady] = useState(false);
  const defaultIndex = options.findIndex(option => option.value === defaultValue);
  const orderedOptions = defaultIndex > 0
    ? [options[defaultIndex], ...options.filter((_, index) => index !== defaultIndex)]
    : options;
  const matchingIndex = orderedOptions.findIndex(option => option.value === value);
  const selectedIndex = allowEmptySelection ? matchingIndex : Math.max(0, matchingIndex);

  useLayoutEffect(() => {
    const updateIndicator = () => {
      const button = buttons.current[selectedIndex];
      if (!root.current || !button) return;
      setIndicator({ left: button.offsetLeft, width: button.offsetWidth });
      setReady(true);
    };
    updateIndicator();
    const observer = typeof ResizeObserver === 'undefined' || !root.current ? null : new ResizeObserver(updateIndicator);
    if (observer && root.current) observer.observe(root.current);
    return () => observer?.disconnect();
  }, [options.length, selectedIndex, defaultValue]);

  return <div ref={root} className={`segmented-control ${ready ? 'ready' : ''} ${className}`.trim()} role="group" aria-label={label} data-tour={dataTour}>
    <span className="segmented-control-indicator" aria-hidden="true" style={{ left: indicator.left, width: indicator.width, opacity: selectedIndex < 0 ? 0 : undefined }} />
    {orderedOptions.map((option, index) => <button
      key={String(option.value)}
      ref={button => { buttons.current[index] = button; }}
      type="button"
      className={`segmented-control-option ${index === selectedIndex ? 'active' : ''} ${option.className ?? ''}`.trim()}
      data-state={index === selectedIndex ? 'active' : 'inactive'}
      aria-pressed={index === selectedIndex}
      disabled={disabled}
      title={option.title}
      onClick={() => onChange(option.value)}
    >
      {option.icon}
      <span>{option.label}</span>
    </button>)}
  </div>;
}

type ToggleAccent = 'green' | 'blue' | 'amber';

export function ToggleButton({
  active,
  onChange,
  label,
  ariaLabel,
  onIcon,
  offIcon,
  onTitle,
  offTitle,
  className = '',
  disabled = false,
  busy = false,
  busyLabel = '加载中…',
  busyIcon,
  accent = 'green',
  dataTour,
}: {
  active: boolean;
  onChange: () => void;
  label: React.ReactNode;
  /** Accessible name for icon-only switches whose visible label is omitted. */
  ariaLabel?: string;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  onTitle?: string;
  offTitle?: string;
  className?: string;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: React.ReactNode;
  busyIcon?: React.ReactNode;
  accent?: ToggleAccent;
  dataTour?: string;
}) {
  const labelText = typeof label === 'string' ? label : '开关';
  const title = active ? (onTitle ?? `关闭${labelText}`) : (offTitle ?? `开启${labelText}`);
  return <ActionButton
    type="button"
    className={`secondary toggle-button ${active ? 'active' : ''} ${className}`.trim()}
    aria-pressed={active}
    aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
    title={title}
    busy={busy}
    busyLabel={busyLabel}
    busyIcon={busyIcon}
    disabled={disabled}
    data-switch="true"
    data-accent={accent}
    data-tour={dataTour}
    onClick={onChange}
  >
    {active ? onIcon : offIcon}
    {label}
  </ActionButton>;
}

type HistoryDateOption = { date: string; pointCount: number };

/** Calendar and time input for future schedules; all values use Beijing time. */
export function DateTimePicker({ value, onChange, label, placeholder, disabled = false }: {
  value: string | null; onChange: (value: string | null) => void; label: string; placeholder: string; disabled?: boolean;
}) {
  const inModal = useContext(ModalContext);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => DateTime.now().setZone('Asia/Shanghai').set({ second: 0, millisecond: 0 }));
  const [month, setMonth] = useState(draft.startOf('month'));
  const updateOpen = (next: boolean) => {
    if (next) { const initial = (value ? DateTime.fromISO(value) : DateTime.now()).setZone('Asia/Shanghai').set({ second: 0, millisecond: 0 }); setDraft(initial); setMonth(initial.startOf('month')); }
    setOpen(next);
  };
  return <div className="schedule-date-field"><span>{label}</span><Popover.Root open={open && !disabled} onOpenChange={updateOpen}>
    <Popover.Trigger asChild><button ref={triggerRef} type="button" className="date-picker-trigger" aria-label={label} disabled={disabled}><CalendarDays size={16} /><span>{value ? DateTime.fromISO(value).setZone('Asia/Shanghai').toFormat('yyyy/MM/dd HH:mm') : placeholder}</span><ChevronDown size={16} /></button></Popover.Trigger>
    <Popover.Portal><UiPopoverContent returnFocusRef={triggerRef} className={`date-picker-popover schedule-date-popover${inModal ? ' ui-modal-popup' : ''}`} align="start" sideOffset={8} collisionPadding={12} aria-label={`${label}选择`}>
      <div className="date-picker-toolbar"><button type="button" className="date-picker-nav" aria-label="上一月" onClick={()=>setMonth(month.minus({ months: 1 }))}><ChevronLeft size={16} /></button><strong>{month.toFormat('yyyy/MM')}</strong><button type="button" className="date-picker-nav" aria-label="下一月" onClick={()=>setMonth(month.plus({ months: 1 }))}><ChevronRight size={16} /></button></div>
      <div className="date-picker-weekdays" aria-hidden="true">{['日','一','二','三','四','五','六'].map(day=><span key={day}>{day}</span>)}</div>
      <div className="date-picker-grid">{Array.from({ length: month.weekday % 7 },(_,index)=><span key={`empty-${index}`} />)}{Array.from({ length: month.daysInMonth ?? 30 },(_,index)=>{
        const date=month.plus({ days: index }); const selected=date.hasSame(draft,'day');
        return <button key={index} type="button" aria-label={date.toFormat('yyyy/MM/dd')} aria-pressed={selected} className={`date-picker-day available ${selected ? 'selected' : ''}`} onClick={()=>setDraft(date.set({ hour: draft.hour, minute: draft.minute }))}><strong>{index+1}</strong></button>;
      })}</div>
      <div className="schedule-time"><UiSelect label="小时" contentClassName="date-picker-menu" value={String(draft.hour)} options={Array.from({ length: 24 },(_,hour)=>({ value: String(hour),label: `${String(hour).padStart(2,'0')} 时` }))} onChange={hour=>setDraft(draft.set({ hour: Number(hour) }))} /><span>:</span><UiSelect label="分钟" contentClassName="date-picker-menu" value={String(draft.minute)} options={Array.from({ length: 60 },(_,minute)=>({ value: String(minute),label: `${String(minute).padStart(2,'0')} 分` }))} onChange={minute=>setDraft(draft.set({ minute: Number(minute) }))} /></div>
      <div className="schedule-time"><ActionButton className="secondary" onClick={()=>{ onChange(null); setOpen(false); }}>清除</ActionButton><ActionButton className="primary" onClick={()=>{ onChange(draft.toISO()); setOpen(false); }}>确定</ActionButton></div>
    </UiPopoverContent></Popover.Portal>
  </Popover.Root></div>;
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function HistoryDatePicker({ value, onChange, options, label, disabled, className = '', dataTour, countLabel = '个采样点', hint = '仅显示有历史采样的日期' }: {
  value: string;
  onChange: (value: string) => void;
  options: HistoryDateOption[];
  label: string;
  disabled?: boolean;
  className?: string;
  dataTour?: string;
  countLabel?: string;
  hint?: string;
}) {
  const inModal = useContext(ModalContext);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const selected = options.find(option => option.date === value);
  const preferredDate = selected?.date || options[0]?.date || new Date().toISOString().slice(0, 10);
  const initial = parseDateKey(preferredDate);
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(initial.year);
  const [viewMonth, setViewMonth] = useState(initial.month);
  const available = new Map(options.map(option => [option.date, option]));
  const monthKeys = [...new Set(options.map(option => option.date.slice(0, 7)))].sort();
  const years = [...new Set(options.map(option => parseDateKey(option.date).year))].sort((left, right) => right - left);
  const monthsForYear = (year: number) => [...new Set(options.filter(option => parseDateKey(option.date).year === year)
    .map(option => parseDateKey(option.date).month))].sort((left, right) => left - right);
  const visibleMonths = monthsForYear(viewYear);
  const currentMonth = monthKey(viewYear, viewMonth);
  const monthIndex = monthKeys.indexOf(currentMonth);
  const previousMonth = monthIndex > 0 ? monthKeys[monthIndex - 1] : undefined;
  const nextMonth = monthIndex >= 0 && monthIndex < monthKeys.length - 1 ? monthKeys[monthIndex + 1] : undefined;
  const daysInMonth = new Date(Date.UTC(viewYear, viewMonth, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(viewYear, viewMonth - 1, 1)).getUTCDay();

  useLayoutEffect(() => {
    if (!open) return;
    const next = parseDateKey(preferredDate);
    setViewYear(next.year);
    setViewMonth(next.month);
  }, [open, preferredDate]);

  useEffect(() => {
    if (disabled || !options.length) setOpen(false);
  }, [disabled, options.length]);

  const selectMonth = (key: string) => {
    const [year, month] = key.split('-').map(Number);
    setViewYear(year);
    setViewMonth(month);
  };
  const selectYear = (year: number) => {
    const months = monthsForYear(year);
    setViewYear(year);
    setViewMonth(months.includes(viewMonth) ? viewMonth : (months[0] ?? 1));
  };
  const formatDateLabel = (date: string) => date.replace(/-/g, '/');
  const shortCountLabel = countLabel === '个采样点' ? '点' : countLabel;
  const display = selected ? `${formatDateLabel(selected.date)} · ${selected.pointCount.toLocaleString('zh-CN')} ${shortCountLabel}` : (value ? formatDateLabel(value) : '选择日期');

  return <Popover.Root open={open} onOpenChange={setOpen}>
    <div className={`history-date-picker ${className}`} data-tour={dataTour}>
      <Popover.Trigger asChild>
        <button ref={triggerRef} type="button" role="combobox" aria-label={label} aria-haspopup="dialog"
          className="date-picker-trigger" disabled={disabled || !options.length}>
          <CalendarDays size={16} aria-hidden="true" /><span>{display}</span><ChevronDown className="date-picker-trigger-icon" size={16} aria-hidden="true" />
        </button>
      </Popover.Trigger>
    </div>
    <Popover.Portal>
      <UiPopoverContent returnFocusRef={triggerRef} ref={calendarRef} className={`date-picker-popover${inModal ? ' ui-modal-popup' : ''}`} aria-label={`${label}选择`}
        align="start" sideOffset={8} collisionPadding={12} sticky="always" hideWhenDetached
        onOpenAutoFocus={event => {
          event.preventDefault();
          const day = calendarRef.current?.querySelector<HTMLButtonElement>('.date-picker-day.selected:not(:disabled)')
            ?? calendarRef.current?.querySelector<HTMLButtonElement>('.date-picker-day.available');
          (day ?? calendarRef.current)?.focus({ preventScroll: true });
        }}>
      <div className="date-picker-heading">
        <div><span>选择日期</span><strong>{viewYear}年{viewMonth}月</strong></div>
        {selected && <small>{selected.pointCount.toLocaleString('zh-CN')} {countLabel}</small>}
      </div>
      <div className="date-picker-toolbar">
        <button type="button" className="date-picker-nav" aria-label="上一个有数据月份" disabled={!previousMonth} onClick={() => previousMonth && selectMonth(previousMonth)}><ChevronLeft size={16} /></button>
        <div className="date-picker-selects">
          <UiSelect label="选择年份" value={String(viewYear)} onChange={next => selectYear(Number(next))}
            options={years.map(year => ({ value: String(year), label: `${year}年` }))}
            className="date-picker-select" contentClassName="date-picker-menu" />
          <UiSelect label="选择月份" value={String(viewMonth)} onChange={next => selectMonth(monthKey(viewYear, Number(next)))}
            options={visibleMonths.map(month => ({ value: String(month), label: `${month}月` }))}
            className="date-picker-select" contentClassName="date-picker-menu" />
        </div>
        <button type="button" className="date-picker-nav" aria-label="下一个有数据月份" disabled={!nextMonth} onClick={() => nextMonth && selectMonth(nextMonth)}><ChevronRight size={16} /></button>
      </div>
      <div className="date-picker-weekdays" aria-hidden="true">{['日', '一', '二', '三', '四', '五', '六'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="date-picker-grid">
        {Array.from({ length: firstWeekday }, (_, index) => <span key={`empty-${index}`} aria-hidden="true" />)}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1;
          const key = dateKey(viewYear, viewMonth, day);
          const option = available.get(key);
          return <button key={key} type="button" className={`date-picker-day ${option ? 'available' : ''} ${key === value ? 'selected' : ''}`} disabled={!option}
            aria-pressed={key === value} aria-label={option ? `${formatDateLabel(key)} · ${option.pointCount.toLocaleString('zh-CN')} ${shortCountLabel}` : `${formatDateLabel(key)} 无数据`} onClick={() => { if (option) { onChange(key); setOpen(false); } }}>
            <strong>{day}</strong>{option && <small>{option.pointCount.toLocaleString('zh-CN')}</small>}
          </button>;
        })}
      </div>
      <div className="date-picker-hint">{hint}</div>
      </UiPopoverContent>
    </Popover.Portal>
  </Popover.Root>;
}

export function UiSelect({ value, onChange, options, label, disabled, className = '', contentClassName = '', searchable = false, searchPlaceholder = '输入名称搜索', dataTour }: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; className?: string }>;
  label: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  dataTour?: string;
}) {
  const inModal = useContext(ModalContext);
  const popupClassName = `${contentClassName}${inModal ? ' ui-modal-popup' : ''}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const [fullscreenContainer, setFullscreenContainer] = useState<Element | null>(null);
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const listId = useId();
  const hasEmptyOption = options.some(option => option.value === '');
  // A body portal is outside the browser fullscreen layer. Keep a select in
  // its fullscreen ancestor so the same menu works for a panel or one tile.
  const portalContainer = fullscreenContainer?.contains(triggerRef.current) ? fullscreenContainer : undefined;
  const normalizedQuery = filterQuery.trim().toLocaleLowerCase();
  const visibleOptions = searchable && normalizedQuery
    ? options.filter(option => option.label.toLocaleLowerCase().includes(normalizedQuery))
    : options;
  const activeIndex = Math.max(0, visibleOptions.findIndex(option => option.value === activeValue));
  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setActiveValue(value);
    else { composingRef.current = false; setQuery(''); setFilterQuery(''); }
  };
  const choose = (next: string) => { onChange(next); changeOpen(false); };
  const changeQuery = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.currentTarget.value);
    if (!composingRef.current && !(event.nativeEvent as InputEvent).isComposing) {
      setFilterQuery(event.currentTarget.value); setActiveValue(null);
    }
  };
  const finishComposition = (event: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    setQuery(event.currentTarget.value); setFilterQuery(event.currentTarget.value); setActiveValue(null);
  };
  const handleSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); changeOpen(false); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (visibleOptions[activeIndex]) choose(visibleOptions[activeIndex].value);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = Math.max(0, Math.min(visibleOptions.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      if (visibleOptions[index]) setActiveValue(visibleOptions[index].value);
    }
  };
  const scrollActiveOption = () => {
    const list = optionsRef.current;
    const item = list?.querySelector<HTMLElement>('[data-highlighted]');
    if (!list || !item) return;
    const bounds = list.getBoundingClientRect(), target = item.getBoundingClientRect();
    if (target.top < bounds.top) list.scrollTop -= bounds.top - target.top;
    else if (target.bottom > bounds.bottom) list.scrollTop += target.bottom - bounds.bottom;
  };
  useModalLayer(open && (!searchable || mobileViewport), surfaceRef);
  useModalFocus(open && searchable && mobileViewport, surfaceRef, searchRef, () => changeOpen(false));
  useEffect(() => {
    const update = () => { setFullscreenContainer(document.fullscreenElement); setOpen(false); };
    setFullscreenContainer(document.fullscreenElement);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setMobileViewport(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  useLayoutEffect(() => {
    if (open && searchable && !mobileViewport) scrollActiveOption();
  }, [open, searchable, activeIndex, filterQuery, mobileViewport]);
  const selectedOption = options.find(option => option.value === value);
  if (mobileViewport && searchable) {
    return <div className={`ui-select-mobile ${className}`} data-tour={dataTour}>
      <button ref={triggerRef} type="button" className="ui-select-trigger ui-select-mobile-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => changeOpen(true)}>
        <span className={selectedOption ? '' : 'ui-select-mobile-placeholder'}>{selectedOption?.label || label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && createPortal(<div className="ui-modal-layer ui-select-mobile-layer" role="presentation" onClick={() => changeOpen(false)}>
        <div ref={surfaceRef} className="ui-select-mobile-sheet" role="dialog" aria-modal="true" aria-label={`${label}选择`} onClick={event => event.stopPropagation()}>
          <div className="ui-select-mobile-heading"><strong>{label}</strong><button type="button" className="ui-select-mobile-close" onClick={() => changeOpen(false)}>完成</button></div>
          <input ref={searchRef} className="ui-select-mobile-search" value={query} onChange={changeQuery}
            onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={finishComposition}
            placeholder={searchPlaceholder} aria-label={`${label}搜索`} onKeyDown={handleSearchKey} />
          <div className="ui-select-mobile-options" role="listbox">
             {visibleOptions.length ? visibleOptions.map(option => <button type="button" role="option" aria-selected={option.value === value} className={`ui-select-mobile-option${option.value === value ? ' selected' : ''}${option.className ? ` ${option.className}` : ''}`} key={option.value} onClick={() => choose(option.value)}>
              <span>{option.label}</span>{option.value === value && <Check size={16} aria-hidden="true" />}
            </button>) : <div className="ui-select-empty">没有匹配的选项</div>}
          </div>
        </div>
      </div>, portalContainer ?? document.body)}
    </div>;
  }
  if (searchable) {
    // Select manages focus on its selected item and cannot host a stable IME
    // input. A Popover lets the input retain DOM focus as results change.
    return <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger asChild><button ref={triggerRef} type="button" role="combobox" aria-label={label} aria-haspopup="listbox"
        aria-controls={listId} aria-expanded={open} disabled={disabled} data-disabled={disabled ? '' : undefined} data-tour={dataTour}
        className={`ui-select-trigger ${className}`.trim()} onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); changeOpen(true); }
        }}>
        <span data-radix-select-value="">{selectedOption?.label || label}</span>
        <span className="ui-select-icon"><ChevronDown size={16} aria-hidden="true" /></span>
      </button></Popover.Trigger>
      <Popover.Portal container={portalContainer}><UiPopoverContent returnFocusRef={triggerRef} className={`ui-select-content ui-searchable-select-content ${popupClassName}`.trim()}
        align="start" sideOffset={6} collisionPadding={10} aria-label={`${label}选择`}
        onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus({ preventScroll: true }); scrollActiveOption(); }}
        onEscapeKeyDown={event => { if (composingRef.current || event.isComposing || event.keyCode === 229) event.preventDefault(); }}>
        <div className="ui-select-search"><input ref={searchRef} value={query} onChange={changeQuery}
          onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={finishComposition}
          placeholder={searchPlaceholder} aria-label={`${label}搜索`} aria-autocomplete="list"
          aria-controls={listId} aria-activedescendant={visibleOptions.length ? `${listId}-${activeIndex}` : undefined}
          onKeyDown={handleSearchKey} /></div>
        <div ref={optionsRef} className="ui-select-viewport ui-searchable-select-options" role="listbox" id={listId} aria-label={label}>
          {visibleOptions.length ? visibleOptions.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option"
            aria-selected={option.value === value} data-state={option.value === value ? 'checked' : 'unchecked'}
            data-highlighted={index === activeIndex ? '' : undefined} className={`ui-select-item${option.className ? ` ${option.className}` : ''}`}
            onPointerMove={() => setActiveValue(option.value)} onPointerDown={event => event.preventDefault()} onClick={() => choose(option.value)}>
            <span>{option.label}</span>{option.value === value && <span className="ui-select-check"><Check size={15} aria-hidden="true" /></span>}
          </div>) : <div className="ui-select-empty">没有匹配的选项</div>}
        </div>
      </UiPopoverContent></Popover.Portal>
    </Popover.Root>;
  }
  return <Select.Root open={open} value={value || (hasEmptyOption ? emptyValue : '')} onValueChange={next => onChange(next === emptyValue ? '' : next)} onOpenChange={nextOpen => { setOpen(nextOpen); if (!nextOpen) setQuery(''); }} disabled={disabled}>
    <Select.Trigger ref={triggerRef} className={`ui-select-trigger ${className}`} aria-label={label} data-tour={dataTour}>
      <Select.Value placeholder={label} />
      <Select.Icon className="ui-select-icon"><ChevronDown size={16} /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={portalContainer}>
      <Select.Content ref={surfaceRef} className={`ui-select-content ${popupClassName}`.trim()} position="popper" sideOffset={6} collisionPadding={10}>
        <Select.ScrollUpButton className="ui-select-scroll"><ChevronUp size={15} /></Select.ScrollUpButton>
        <Select.Viewport className="ui-select-viewport">
           {visibleOptions.length ? visibleOptions.map(option => <Select.Item key={option.value} value={option.value || emptyValue} className={`ui-select-item${option.className ? ` ${option.className}` : ''}`}>
              <Select.ItemText>{option.label}</Select.ItemText>
              <Select.ItemIndicator className="ui-select-check"><Check size={15} /></Select.ItemIndicator>
            </Select.Item>) : <div className="ui-select-empty">没有匹配的选项</div>}
        </Select.Viewport>
        <Select.ScrollDownButton className="ui-select-scroll"><ChevronDown size={15} /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}

/** Alerts share positioning/scroll behavior with every other modal surface. */
export function ConfirmDialog({ open, onOpenChange, heading, description, onConfirm, trigger, returnFocus, busy = false, busyLabel = '处理中…' }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  heading: string;
  description: string;
  onConfirm: () => void;
  trigger?: React.ReactNode;
  returnFocus: () => HTMLElement | null | undefined;
  busy?: boolean;
  busyLabel?: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useModalLayer(open, contentRef);
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
    {trigger && <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>}
    <AlertDialog.Portal>
      {/* Radix Overlay includes a second body scroll lock. The shared modal
          layer owns the backdrop and page lock instead. */}
      <div className="ui-modal-layer ui-dialog-overlay">
        <AlertDialog.Content ref={contentRef} className="ui-dialog-content" onCloseAutoFocus={event => {
          event.preventDefault(); returnFocus()?.focus({ preventScroll: true });
        }}>
          <AlertDialog.Title className="ui-dialog-title">{heading}</AlertDialog.Title>
          <AlertDialog.Description className="ui-dialog-description">{description}</AlertDialog.Description>
          <div className="ui-dialog-actions">
            <AlertDialog.Cancel asChild><button type="button" className="secondary">取消</button></AlertDialog.Cancel>
            <AlertDialog.Action asChild><ActionButton className="primary danger-action" onClick={onConfirm} busy={busy} busyLabel={busyLabel}>确认删除</ActionButton></AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </div>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

export function ConfirmAction({ label, heading, description, onConfirm, children, className = '', busy = false, busyLabel = '处理中…' }: {
  label: string;
  heading: string;
  description: string;
  onConfirm: () => void;
  children: React.ReactNode;
  className?: string;
  busy?: boolean;
  busyLabel?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <ConfirmDialog open={open} onOpenChange={setOpen} heading={heading} description={description} onConfirm={onConfirm}
    busy={busy} busyLabel={busyLabel} returnFocus={() => triggerRef.current}
    trigger={<ActionButton ref={triggerRef} className={className} title={label} aria-label={label} busy={busy} busyLabel={busyLabel}>{children}</ActionButton>} />;
}
