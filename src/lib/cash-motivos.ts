import type { CashMovementType } from '../services/api';

// Presentation + mapping layer for cash movements, ported 1:1 from the admin
// dashboard (MerchantAI cash-ui.ts) so the cashier and the owner share ONE
// mental model: Entrada / Salida + motivo. The motivo -> cash_movements.type
// mapping lives here; the modal stays presentational.
//
// Scoped to the cashier device: no supplier picker and no treasury container
// dual-write (those are owner-only and the /pos/cash/movement endpoint only
// accepts { type, amount, reason }). "Pago a proveedor" is kept as a motivo but
// the provider, when relevant, is written in the free-text note.

export type Direction = 'in' | 'out';

/** Motivos shown when registering an Entrada (cash in). */
export type EntryMotivo =
  | 'fondo_caja'
  | 'reposicion_caja_chica'
  | 'correccion_error'
  | 'aporte_capital'
  | 'otro';

/** Motivos shown when registering a Salida (cash out). */
export type ExitMotivo =
  | 'retiro_seguridad'
  | 'pago_proveedor'
  | 'gasto_menor'
  | 'devolucion_cliente'
  | 'vale_empleado'
  | 'otro';

export const ENTRY_MOTIVOS: { value: EntryMotivo; label: string }[] = [
  { value: 'fondo_caja',            label: 'Fondo de caja' },
  { value: 'reposicion_caja_chica', label: 'Reposición de caja chica' },
  { value: 'correccion_error',      label: 'Corrección de error' },
  { value: 'aporte_capital',        label: 'Aporte de capital' },
  { value: 'otro',                  label: 'Otro' },
];

export const EXIT_MOTIVOS: { value: ExitMotivo; label: string }[] = [
  { value: 'retiro_seguridad',  label: 'Retiro de seguridad' },
  { value: 'pago_proveedor',    label: 'Pago a proveedor' },
  { value: 'gasto_menor',       label: 'Gasto menor' },
  { value: 'devolucion_cliente', label: 'Devolución a cliente' },
  { value: 'vale_empleado',     label: 'Vale de empleado' },
  { value: 'otro',              label: 'Otro' },
];

/**
 * Quick-pick reason presets per motivo. Tapping a chip fills the free-text note;
 * the cashier can always override it. Motivos without presets ("Otro") render
 * the note field with no chips.
 */
export const REASON_PRESETS: Partial<
  Record<EntryMotivo | ExitMotivo, string[]>
> = {
  // Entradas
  fondo_caja:            ['Fondo inicial del turno', 'Reposición de fondo'],
  reposicion_caja_chica: ['Reposición de caja chica'],
  correccion_error:      ['Corrección de conteo', 'Error de cobro'],
  aporte_capital:        ['Aporte del dueño', 'Préstamo de socio'],
  // Salidas
  retiro_seguridad:  ['Retiro a caja fuerte', 'Consignación al banco'],
  pago_proveedor:    ['Pago contado', 'Abono a proveedor'],
  gasto_menor:       ['Papelería', 'Aseo', 'Transporte / fletes', 'Refrigerios'],
  devolucion_cliente: ['Devolución de venta', 'Reembolso de seña'],
  vale_empleado:     ['Adelanto de salario', 'Préstamo a empleado'],
};

// ── Motivo (UI) -> cash_movements.type (DB) ──────────────────────────────────
// Mirrors the admin enum semantics: adjustment/deposit raise drawer cash (not
// revenue); withdrawal lowers cash but is NOT a P&L expense; advance is an
// employee receivable; everything else is operating expense.

export function entryTypeFor(motivo: EntryMotivo): CashMovementType {
  return motivo === 'correccion_error' ? 'adjustment' : 'deposit';
}

export function exitTypeFor(motivo: ExitMotivo): CashMovementType {
  if (motivo === 'retiro_seguridad') {
    return 'withdrawal';
  }
  if (motivo === 'vale_empleado') {
    return 'advance';
  }
  return 'expense';
}

/**
 * Compose the { type, reason } the POS sends to /pos/cash/movement. Mirrors the
 * dashboard's reason composition: "Otro" uses the raw note; otherwise the reason
 * is the motivo label, optionally suffixed with the note.
 */
export function composeMovement(
  direction: Direction,
  motivo: EntryMotivo | ExitMotivo,
  note: string,
): { type: CashMovementType; reason: string } {
  const trimmed = note.trim();
  const list = direction === 'in' ? ENTRY_MOTIVOS : EXIT_MOTIVOS;
  const label = list.find(o => o.value === motivo)?.label ?? '';
  const isOtro = motivo === 'otro';

  const type =
    direction === 'in'
      ? entryTypeFor(motivo as EntryMotivo)
      : exitTypeFor(motivo as ExitMotivo);
  const reason = isOtro
    ? trimmed
    : trimmed
      ? `${label} — ${trimmed}`
      : label;

  return { type, reason };
}
