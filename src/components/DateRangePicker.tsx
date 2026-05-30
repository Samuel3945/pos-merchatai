import { useState, useRef, useEffect } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function toYMD(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function bogotaToday() {
  const str = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d: Date, n: number) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtShort(d: Date) {
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}
function fmtMonthYear(d: Date) {
  return d.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
}

// ── Presets ───────────────────────────────────────────────────────────────────

export const PRESETS = [
  { id: 'today',    label: 'Hoy' },
  { id: 'yesterday',label: 'Ayer' },
  { id: 'last7',    label: 'Últimos 7 días' },
  { id: 'last30',   label: 'Últimos 30 días' },
  { id: 'last90',   label: 'Últimos 90 días' },
  { id: 'thisMonth',label: 'Este mes' },
  { id: 'lastMonth',label: 'Mes pasado' },
  { id: 'last12m',  label: 'Últimos 12 meses' },
  { id: 'thisYear', label: 'Este año' },
  { id: 'custom',   label: 'Personalizado' },
] as const;

export type PresetId = typeof PRESETS[number]['id'];

export function presetToRange(id: PresetId): Omit<DateRange, 'label'> {
  const today = bogotaToday();
  switch (id) {
    case 'today':     return { start: today, end: today };
    case 'yesterday': { const y = addDays(today, -1); return { start: y, end: y }; }
    case 'last7':     return { start: addDays(today, -6), end: today };
    case 'last30':    return { start: addDays(today, -29), end: today };
    case 'last90':    return { start: addDays(today, -89), end: today };
    case 'thisMonth': return { start: startOfMonth(today), end: today };
    case 'lastMonth': {
      const lm = addMonths(today, -1);
      return { start: startOfMonth(lm), end: endOfMonth(lm) };
    }
    case 'last12m':   return { start: addDays(addMonths(today, -12), 1), end: today };
    case 'thisYear':  return { start: new Date(today.getFullYear(), 0, 1), end: today };
    default:          return { start: today, end: today };
  }
}

function getPresetId(range: DateRange): PresetId {
  for (const p of PRESETS) {
    if (p.id === 'custom') continue;
    const r = presetToRange(p.id);
    if (sameDay(r.start, range.start) && sameDay(r.end, range.end)) return p.id;
  }
  return 'custom';
}

export function compareForRange(range: DateRange, mode: 'prev_period' | 'prev_year'): DateRange {
  const days = Math.round((range.end.getTime() - range.start.getTime()) / 86400000) + 1;
  if (mode === 'prev_period') {
    const end = addDays(range.start, -1);
    return { start: addDays(end, -(days - 1)), end, label: 'Período anterior' };
  } else {
    return {
      start: addDays(range.start, -365),
      end:   addDays(range.end, -365),
      label: 'Año anterior',
    };
  }
}

// ── Mini calendar ─────────────────────────────────────────────────────────────

function MiniCalendar({
  viewMonth, viewYear, rangeStart, rangeEnd, hover,
  onDay, onHover, onPrevMonth, onNextMonth,
}: {
  viewMonth: number; viewYear: number;
  rangeStart: Date | null; rangeEnd: Date | null; hover: Date | null;
  onDay: (d: Date) => void; onHover: (d: Date | null) => void;
  onPrevMonth: () => void; onNextMonth: () => void;
}) {
  const today = bogotaToday();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const blanks = (firstDow + 6) % 7; // Mon-first
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const cells: (Date | null)[] = [
    ...Array(blanks).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(viewYear, viewMonth, i + 1)),
  ];

  const effectiveEnd = rangeEnd ?? hover;

  function dayClass(d: Date) {
    if (!d) return '';
    const isStart  = rangeStart && sameDay(d, rangeStart);
    const isEnd    = effectiveEnd && sameDay(d, effectiveEnd);
    const inRange  = rangeStart && effectiveEnd && d > (rangeStart < effectiveEnd ? rangeStart : effectiveEnd) && d < (rangeStart < effectiveEnd ? effectiveEnd : rangeStart);
    const isToday  = sameDay(d, today);
    const isFuture = d > today;

    if (isStart || isEnd) return 'bg-[#9acee1] text-[#003542] font-bold rounded-lg';
    if (inRange) return 'bg-[#9acee1]/20 text-[#e1e2e4] rounded-none';
    if (isFuture) return 'text-[#40484b] cursor-not-allowed';
    if (isToday) return 'text-[#9acee1] font-bold hover:bg-[#282a2b] rounded-lg';
    return 'text-[#e1e2e4] hover:bg-[#282a2b] rounded-lg';
  }

  const monthDate = new Date(viewYear, viewMonth, 1);

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-3">
        <button onClick={onPrevMonth}
          className="p-1 text-[#8a9295] hover:text-[#e1e2e4] hover:bg-[#282a2b] rounded-lg transition-colors">
          <span className="material-symbols-outlined text-[18px]">chevron_left</span>
        </button>
        <span className="text-[#e1e2e4] font-semibold text-sm capitalize">{fmtMonthYear(monthDate)}</span>
        <button onClick={onNextMonth}
          className="p-1 text-[#8a9295] hover:text-[#e1e2e4] hover:bg-[#282a2b] rounded-lg transition-colors">
          <span className="material-symbols-outlined text-[18px]">chevron_right</span>
        </button>
      </div>
      <div className="grid grid-cols-7 mb-1">
        {['Lu','Ma','Mi','Ju','Vi','Sa','Do'].map(h => (
          <div key={h} className="text-center text-[#8a9295] text-xs py-1 font-semibold">{h}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => !d ? (
          <div key={i} />
        ) : (
          <button key={i}
            onClick={() => { if (d <= today) onDay(d); }}
            onMouseEnter={() => onHover(d)}
            onMouseLeave={() => onHover(null)}
            disabled={d > today}
            className={`h-8 w-full text-center text-sm transition-colors ${dayClass(d)}`}>
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main DateRangePicker ──────────────────────────────────────────────────────

export interface CompareConfig {
  enabled: boolean;
  mode: 'prev_period' | 'prev_year';
  range: DateRange;
}

interface Props {
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
}

export default function DateRangePicker({ range, onRangeChange }: Props) {
  const [open, setOpen] = useState(false);
  const [activePreset, setActivePreset] = useState<PresetId>(() => getPresetId(range));

  const [tempStart, setTempStart] = useState<Date | null>(range.start);
  const [tempEnd, setTempEnd]     = useState<Date | null>(range.end);
  const [hover, setHover]         = useState<Date | null>(null);
  const [selecting, setSelecting] = useState<'start' | 'end'>('start');
  const today = bogotaToday();
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear]   = useState(today.getFullYear());

  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const openPicker = () => {
    setTempStart(range.start); setTempEnd(range.end);
    setActivePreset(getPresetId(range));
    setSelecting('start');
    setViewMonth(range.end.getMonth());
    setViewYear(range.end.getFullYear());
    setOpen(true);
  };

  const handlePresetClick = (id: PresetId) => {
    setActivePreset(id);
    if (id === 'custom') return;
    const r = presetToRange(id);
    setTempStart(r.start); setTempEnd(r.end); setSelecting('start');
    setViewMonth(r.end.getMonth()); setViewYear(r.end.getFullYear());
  };

  const handleDay = (d: Date) => {
    if (selecting === 'start') {
      setTempStart(d); setTempEnd(null); setSelecting('end');
      setActivePreset('custom');
    } else {
      if (tempStart && d < tempStart) {
        setTempStart(d); setTempEnd(tempStart);
      } else {
        setTempEnd(d);
      }
      setSelecting('start');
      setActivePreset('custom');
    }
  };

  const handleApply = () => {
    if (!tempStart || !tempEnd) return;
    const label = activePreset === 'custom'
      ? `${fmtShort(tempStart)} – ${fmtShort(tempEnd)}`
      : PRESETS.find(p => p.id === activePreset)?.label ?? '';
    onRangeChange({ start: tempStart, end: tempEnd, label });
    setOpen(false);
  };

  const displayLabel = range.label || `${fmtShort(range.start)} – ${fmtShort(range.end)}`;

  return (
    <div ref={pickerRef} className="relative">
        <button onClick={openPicker}
          className="flex items-center gap-2 bg-[#1E1E1E] border border-[#333333] hover:border-[#9acee1] text-[#e1e2e4] font-semibold text-sm px-4 py-2.5 rounded-xl transition-colors active:scale-[0.98]">
          <span className="material-symbols-outlined text-[#9acee1] text-[18px]">date_range</span>
          {displayLabel}
          <span className="material-symbols-outlined text-[#8a9295] text-[16px]">expand_more</span>
        </button>

        {open && (
          <div className="absolute top-full right-0 mt-2 z-50 bg-[#1E1E1E] border border-[#333333] rounded-2xl shadow-[0px_8px_32px_rgba(0,0,0,0.6)] flex flex-col sm:flex-row overflow-hidden max-w-[calc(100vw-2rem)]"
            style={{ width: 'min(560px, calc(100vw - 2rem))' }}>
            <div className="w-full sm:w-44 border-b sm:border-b-0 sm:border-r border-[#333333] p-3 space-y-1 max-h-40 sm:max-h-none overflow-y-auto">
              <p className="text-[#8a9295] text-xs font-bold uppercase tracking-wider px-2 py-1">Período</p>
              {PRESETS.map(p => (
                <button key={p.id} onClick={() => handlePresetClick(p.id)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
                    activePreset === p.id
                      ? 'bg-[#0f4c5c] text-[#9acee1]'
                      : 'text-[#c0c8cb] hover:bg-[#282a2b]'
                  }`}>
                  {p.label}
                </button>
              ))}
            </div>

            <div className="flex-1 flex flex-col">
              <div className="p-4 flex-1">
                <MiniCalendar
                  viewMonth={viewMonth} viewYear={viewYear}
                  rangeStart={tempStart} rangeEnd={tempEnd} hover={hover}
                  onDay={handleDay} onHover={setHover}
                  onPrevMonth={() => {
                    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
                    else setViewMonth(m => m - 1);
                  }}
                  onNextMonth={() => {
                    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
                    else setViewMonth(m => m + 1);
                  }}
                />
              </div>

              <div className="border-t border-[#333333] px-4 py-3 flex items-center gap-2 text-sm">
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-[#8a9295] text-xs">De:</span>
                  <input type="date"
                    value={tempStart ? toYMD(tempStart) : ''}
                    max={toYMD(today)}
                    onChange={e => { const d = new Date(e.target.value + 'T00:00:00'); if (!isNaN(d.getTime())) { setTempStart(d); setActivePreset('custom'); }}}
                    className="bg-[#121212] border border-[#333333] rounded-lg px-2 py-1.5 text-[#e1e2e4] text-xs focus:border-[#9acee1] transition-colors flex-1" />
                  <span className="text-[#8a9295] text-xs">Hasta:</span>
                  <input type="date"
                    value={tempEnd ? toYMD(tempEnd) : ''}
                    min={tempStart ? toYMD(tempStart) : ''}
                    max={toYMD(today)}
                    onChange={e => { const d = new Date(e.target.value + 'T00:00:00'); if (!isNaN(d.getTime())) { setTempEnd(d); setActivePreset('custom'); }}}
                    className="bg-[#121212] border border-[#333333] rounded-lg px-2 py-1.5 text-[#e1e2e4] text-xs focus:border-[#9acee1] transition-colors flex-1" />
                </div>
              </div>

              <div className="border-t border-[#333333] px-4 py-3 flex justify-end gap-2">
                <button onClick={() => setOpen(false)}
                  className="px-4 py-2 bg-[#1d2021] border border-[#333333] text-[#c0c8cb] font-semibold text-sm rounded-xl hover:bg-[#282a2b] transition-colors">
                  Cancelar
                </button>
                <button onClick={handleApply}
                  disabled={!tempStart || !tempEnd}
                  className="px-4 py-2 bg-[#0f4c5c] hover:bg-[#155a6d] disabled:opacity-40 text-[#87bbce] font-bold text-sm rounded-xl transition-colors">
                  Aplicar
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
