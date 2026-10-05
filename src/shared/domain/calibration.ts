/** Port of expected_calibration_error. computeEce is the alias. */
export function expectedCalibrationError(
  confidences: number[],
  correctness: (boolean | number)[],
  nBins = 10,
): number {
  if (confidences.length === 0) return 0;
  let ece = 0;
  for (let b = 0; b < nBins; b++) {
    const lo = b / nBins;
    const hi = (b + 1) / nBins;
    let sumC = 0; let sumA = 0; let count = 0;
    for (let i = 0; i < confidences.length; i++) {
      const c = confidences[i] as number;
      if (c > lo && c <= hi) {
        sumC += c; sumA += Number(correctness[i]); count++;
      }
    }
    if (count === 0) continue;
    ece += (count / confidences.length) * Math.abs(sumC / count - sumA / count);
  }
  return ece;
}

export const computeEce = expectedCalibrationError;
