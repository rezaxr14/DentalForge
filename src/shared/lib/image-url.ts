/**
 * Public URL for a stored image key.
 *
 * Demo assets and the committed label derivatives live under `public/`, so the
 * browser can fetch them directly. Absolute local paths (the M7 importer's
 * default) are deliberately NOT exposed — a production page must never leak
 * `C:\Users\...`.
 */
export function publicImageUrl(storageKey: string | null | undefined): string | null {
  if (!storageKey) return null;
  const key = storageKey.replace(/^\/+/, "").replace(/\\/g, "/");
  if (key.startsWith("demo-assets/") || key.startsWith("labels/")) return `/${key}`;
  return null;
}
