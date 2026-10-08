# NOTICE — images in this repository (plan §12.4)

## `public/labels/1.jpg` … `5.jpg`

**What they are.** Downscaled, recompressed derivatives of five training
images from the **DENTEX** dataset (Dental Enumeration and Diagnosis on
Panoramic X-rays Challenge, MICCAI 2023), used by the LabelForge demo. Their
annotations live in `fixtures/labels/*.json`; the images are resized for web
display only — no other modification.

**Source dataset.**

- DENTEX: <https://huggingface.co/datasets/ibrahimhamamci/DENTEX>
- Challenge: <https://dentex.grand-challenge.org/data/>
- Paper: Hamamci et al., *DENTEX: An Abnormal Tooth Detection with Dental
  Enumeration and Diagnosis Benchmark for Panoramic X-rays*, arXiv:2305.19112
  (MICCAI 2023)

**License: CC BY-NC-SA 4.0** (Creative Commons Attribution-NonCommercial-
ShareAlike 4.0). Verified against the official dataset card (2026-10-08),
which states: "all elements of the DENTEX dataset are released under a
Creative Commons Attribution (CC-BY-NC-SA) license … freely used for
non-commercial research purposes … provided that the original work is
properly cited and any derivative works are shared under similar terms."
The per-image `license` field in `fixtures/labels/*.json` records the same.

**Terms that apply to these derivatives:**

1. **Attribution** — credit the DENTEX dataset and the citation above when
   redistributing or reusing.
2. **NonCommercial** — no commercial use of these images.
3. **ShareAlike** — because these are derivative works, any redistributed or
   modified version of them must carry this same CC BY-NC-SA 4.0 license.
   This NOTICE must travel with the images.
4. **Not for clinical use** — they are part of a research prototype (see the
   app's persistent notice) and must not be used for clinical decisions.

## `public/radiograph.jpg` (Tool Lab default image)

Provenance was not recorded when this file landed in M4; until it is
confirmed it is **treated as a DENTEX derivative under CC BY-NC-SA 4.0** on
the same terms as above. Confirm the source and update this section.

## Tufts datasets — NOT included, confirmed separately

No image from the Tufts University datasets is present under `public/`.
Tufts-derived assets are governed by their own terms, which are **not** covered
by this notice and must be confirmed with the dataset stewards separately
*before* any such image is added to this repository or shown to non-members
(plan §12.4 / risk R3).
