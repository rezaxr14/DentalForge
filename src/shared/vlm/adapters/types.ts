/**
 * Shared adapter vocabulary (ADR-0024). Kept separate from `trace.ts` so a new reader can be added
 * without importing the trace schemas.
 */
export interface AdapterSkip {
  line: number;
  reason: string;
}

export interface AdapterDiagnostics {
  adapter: string;
  version: string;
  linesRead: number;
  linesSkipped: number;
  unknownFields: Record<string, number>;
  variants: Record<string, number>;
  skipped: AdapterSkip[];
}
