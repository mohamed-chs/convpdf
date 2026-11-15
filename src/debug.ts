/** Timing trace, enabled with MDPDF_DEBUG=1. */
const enabled = !!process.env['MDPDF_DEBUG'];
const origin = performance.now();

export function trace(label: string, since?: number): number {
  const now = performance.now();
  if (enabled) {
    const delta = since !== undefined ? ` (+${(now - since).toFixed(1)} ms)` : '';
    process.stderr.write(`[mdpdf ${(now - origin).toFixed(1).padStart(7)} ms] ${label}${delta}\n`);
  }
  return now;
}
