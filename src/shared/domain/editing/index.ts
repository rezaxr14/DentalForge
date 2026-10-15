export * as history from "./history";
export type { History, Command, AnnotationPatch } from "./history";
export { feedDigit, initialEntry, pathologyForCode, FDI_ENTRY_TIMEOUT_MS, type EntryState } from "./fdi-entry";
export { odontogram, ODONTOGRAM_LAYOUT, type Slot, type SlotState } from "./odontogram";
export { mirrorAnnotation } from "./mirror";
export { nextIndex } from "./ids";
