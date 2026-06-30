import { useState } from 'react';

// Custom, app-themed credit due-date picker. Replaces the native `<input
// type="date">` calendar (OS-controlled, unstyleable) with a Monday-first month
// grid plus the quick presets cashiers use most. Values are local-time YYYY-MM-DD.

const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const PRESETS = [
  { label: 'Mañana', days: 1 },
  { label: '15 días', days: 15 },
  { label: '30 días', days: 30 },
];

const toISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const fromISO = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const isoDaysFromToday = (days: number): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return toISO(d);
};

export function DueDateCalendar({
  value,
  onChange,
}: {
  value: string;
  onChange: (iso: string) => void;
}) {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const selectedDate = valid ? fromISO(value) : new Date();
  const todayISO = isoDaysFromToday(0);

  // Which month the grid is showing. Starts on the selected date's month.
  const [view, setView] = useState(() => ({
    y: selectedDate.getFullYear(),
    m: selectedDate.getMonth(),
  }));

  // Selecting any date also jumps the grid to that date's month (so a preset in
  // another month is visible right away).
  const select = (iso: string) => {
    onChange(iso);
    const d = fromISO(iso);
    setView({ y: d.getFullYear(), m: d.getMonth() });
  };

  const step = (delta: number) =>
    setView((v) => {
      const m = v.m + delta;
      if (m < 0) return { y: v.y - 1, m: 11 };
      if (m > 11) return { y: v.y + 1, m: 0 };
      return { y: v.y, m };
    });

  // Monday-first grid. JS getDay() is Sunday=0..Saturday=6.
  const firstWeekday = (new Date(view.y, view.m, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(view.y, view.m, d));
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div>
      {/* Quick presets — the one-tap path for the common cases */}
      <div className="flex gap-1.5 mb-2">
        {PRESETS.map((p) => {
          const iso = isoDaysFromToday(p.days);
          const active = value === iso;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => select(iso)}
              className={`flex-1 px-2 py-2 rounded-lg text-xs font-bold border transition-colors ${
                active
                  ? 'bg-warn text-white border-warn'
                  : 'bg-surface text-warn border-warn/50 hover:bg-warn-soft'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Themed month grid */}
      <div className="bg-surface border border-warn/40 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-2 px-0.5">
          <span className="text-ink font-bold text-sm capitalize">
            {MONTHS[view.m]} {view.y}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Mes anterior"
              className="w-7 h-7 grid place-items-center rounded-lg text-ink-2 hover:bg-warn-soft hover:text-warn transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">chevron_left</span>
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Mes siguiente"
              className="w-7 h-7 grid place-items-center rounded-lg text-ink-2 hover:bg-warn-soft hover:text-warn transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">chevron_right</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-0.5 mb-1">
          {WEEKDAYS.map((w) => (
            <div key={w} className="text-center text-[10px] font-bold text-ink-3 py-0.5">
              {w}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d, i) => {
            if (!d) return <div key={i} />;
            const iso = toISO(d);
            const isSelected = iso === value;
            const isToday = iso === todayISO;
            const isPast = iso < todayISO;
            return (
              <button
                key={i}
                type="button"
                disabled={isPast}
                onClick={() => select(iso)}
                aria-label={iso}
                className={`h-9 rounded-lg text-sm font-semibold transition-colors ${
                  isSelected
                    ? 'bg-warn text-white'
                    : isPast
                      ? 'text-ink-4 cursor-not-allowed'
                      : isToday
                        ? 'text-warn ring-1 ring-warn/50 hover:bg-warn-soft'
                        : 'text-ink hover:bg-warn-soft'
                }`}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
