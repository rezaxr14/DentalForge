/**
 * FDI quick entry (plan §11.3): with a box selected, type the quadrant digit then the position digit ("4","6" sets
 * tooth 46). Pure state machine; time is injected so the timeout is testable.
 *
 * Plain digits are FDI entry. The plan also lists "pathology hotkeys (1–4)", which would collide with them, so
 * pathology uses Alt+1..4 (ADR-0018).
 */
import { PATHOLOGY_LABELS } from "@/shared/contracts/labels";

export const FDI_ENTRY_TIMEOUT_MS = 1500;

export interface EntryState {
  quadrant: number | null;
  at: number;
}

export const initialEntry: EntryState = { quadrant: null, at: 0 };

export interface EntryResult {
  state: EntryState;
  /** Set when the second digit completed a tooth. */
  commit?: { quadrant: number; position: number };
  /** True when the key was part of FDI entry (the caller should preventDefault); false = not ours, ignore. */
  consumed: boolean;
}

export function feedDigit(state: EntryState, digit: string, now: number): EntryResult {
  if (!/^[0-9]$/.test(digit)) return { state: initialEntry, consumed: false };
  const n = Number(digit);
  const pending = state.quadrant !== null && now - state.at <= FDI_ENTRY_TIMEOUT_MS ? state.quadrant : null;

  if (pending === null) {
    if (n >= 1 && n <= 4) return { state: { quadrant: n, at: now }, consumed: true };
    return { state: initialEntry, consumed: false }; // 0, 5-9 cannot start a tooth number
  }
  if (n >= 1 && n <= 8) return { state: initialEntry, commit: { quadrant: pending, position: n }, consumed: true };
  return { state: initialEntry, consumed: true }; // 0 or 9 after a quadrant: abandon the entry, swallow the key
}

/** Alt+Digit1..4 → pathology, by physical key (`event.code`), so keyboard layouts and Alt-composed characters don't matter. */
export function pathologyForCode(code: string): (typeof PATHOLOGY_LABELS)[number] | null {
  const m = /^Digit([1-4])$/.exec(code);
  return m ? (PATHOLOGY_LABELS[Number(m[1]) - 1] ?? null) : null;
}
