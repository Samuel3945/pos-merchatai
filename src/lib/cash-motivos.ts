import type { CashMovementType } from '../services/api';

// Presentation + mapping layer for cashier cash movements: Entrada / Salida +
// motivo. The motivo -> cash_movements.type mapping lives here; the modal stays
// presentational.
//
// These are the CASHIER's motivos — a deliberate subset of the owner dashboard.
// The owner has more (e.g. "Retiro de seguridad" for treasury) because moving
// cash to a safe/bank is an owner action, not a till action. Customer refunds
// are intentionally absent too: the POS handles those through the dedicated
// returns flow (api.sales.processReturn), not a manual movement.
//
// Scoped to the device: no treasury container dual-write. The one rich field the
// cashier does get is the supplier link on "Pago a proveedor" (chosen from
// /pos/suppliers, persisted as cash_movements.supplier_id).

export type Direction = 'in' | 'out';

/** Motivos shown when registering an Entrada (cash in). */
export type EntryMotivo =
  | 'ingreso_base'
  | 'aporte_capital'
  | 'abono_prestamo';

/** Motivos shown when registering a Salida (cash out). */
export type ExitMotivo =
  | 'gasto_menor'
  | 'pago_proveedor'
  | 'vale_empleado';

export const ENTRY_MOTIVOS: { value: EntryMotivo; label: string }[] = [
  { value: 'ingreso_base',    label: 'Ingreso de base' },
  { value: 'aporte_capital',  label: 'Aporte de capital' },
  { value: 'abono_prestamo',  label: 'Abono de préstamo' },
];

export const EXIT_MOTIVOS: { value: ExitMotivo; label: string }[] = [
  { value: 'gasto_menor',    label: 'Gasto menor' },
  { value: 'pago_proveedor', label: 'Pago a proveedor' },
  { value: 'vale_empleado',  label: 'Vale de empleado' },
];

/**
 * Quick-pick reason presets per motivo. Tapping a chip fills the free-text note;
 * the cashier can always override it. "Pago a proveedor" has no presets — the
 * supplier select carries the "who"; the note is just an optional detail.
 */
export const REASON_PRESETS: Partial<
  Record<EntryMotivo | ExitMotivo, string[]>
> = {
  // Entradas
  ingreso_base:   ['Base inicial del turno', 'Más sencillo / cambio'],
  aporte_capital: ['Aporte del dueño', 'Préstamo de socio'],
  // Salidas
  gasto_menor:    ['Aseo', 'Papelería', 'Transporte / fletes', 'Refrigerios', 'Servicios'],
  vale_empleado:  ['Adelanto de salario', 'Préstamo a empleado'],
};

// ── Motivo (UI) -> cash_movements.type (DB) ──────────────────────────────────
// deposit raises drawer cash (not revenue); advance is an employee receivable;
// everything else out of the till is operating expense.

export function entryTypeFor(_motivo: EntryMotivo): CashMovementType {
  // Every cashier entrada (base, aporte, abono de préstamo) is real cash into
  // the drawer.
  return 'deposit';
}

export function exitTypeFor(motivo: ExitMotivo): CashMovementType {
  // Employee advance: cash out + a receivable against future salary, not an
  // expense yet — its own type so reports can isolate "vales empleados".
  if (motivo === 'vale_empleado') {
    return 'advance';
  }
  // Gasto menor y pago a proveedor son gasto operativo (expense).
  return 'expense';
}

/**
 * Compose the { type, reason } the POS sends to /pos/cash/movement. "Pago a
 * proveedor" leads with the chosen supplier name; every other motivo uses its
 * label, optionally suffixed with the note.
 */
export function composeMovement(
  direction: Direction,
  motivo: EntryMotivo | ExitMotivo,
  note: string,
  supplierName?: string | null,
): { type: CashMovementType; reason: string } {
  const trimmed = note.trim();
  const list = direction === 'in' ? ENTRY_MOTIVOS : EXIT_MOTIVOS;
  const label = list.find(o => o.value === motivo)?.label ?? '';
  const withNote = (base: string) => (trimmed ? `${base} — ${trimmed}` : base);

  const type =
    direction === 'in'
      ? entryTypeFor(motivo as EntryMotivo)
      : exitTypeFor(motivo as ExitMotivo);

  let reason: string;
  if (motivo === 'pago_proveedor') {
    reason = withNote(supplierName ? `Pago a ${supplierName}` : 'Pago a proveedor');
  } else if (motivo === 'abono_prestamo') {
    reason = withNote('Abono de préstamo');
  } else {
    reason = withNote(label);
  }

  return { type, reason };
}
