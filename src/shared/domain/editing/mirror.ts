/**
 * Duplicate-to-mirror (plan §11.3): copy a box onto the contralateral tooth. The box is reflected across the
 * image's vertical midline and gets the flipped quadrant (1↔2, 3↔4) with the same position and pathology.
 * It is a starting point the annotator then adjusts: teeth are not perfectly symmetric about the image centre.
 */
import type { Annotation } from "@/shared/contracts/labels";
import { clampBox, type Bbox } from "@/shared/domain/annotation";
import { flipQuadrant } from "@/shared/domain/fdi";

export function mirrorAnnotation(
  a: Annotation,
  image: { width: number; height: number },
  meta: { id: string; authorId: string },
): Annotation | null {
  const [x, y, w, h] = a.bbox;
  const box = clampBox([image.width - (x + w), y, w, h] as Bbox, image.width, image.height);
  if (!box) return null;
  return {
    id: meta.id,
    bbox: box,
    fdi_quadrant: flipQuadrant(a.fdi_quadrant),
    fdi_position: a.fdi_position,
    pathology: a.pathology,
    source: "human",
    confidence: null,
    status: "draft",
    version: 1,
    author_id: meta.authorId,
  };
}
