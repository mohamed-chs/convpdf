/** Timing trace, enabled with CONVPDF_DEBUG=1. Times are since process start. */
const enabled = !!process.env['CONVPDF_DEBUG'];
const origin = 0;
if (enabled) process.on('exit', () => trace('exit'));

export function trace(label: string, since?: number): number {
  const now = performance.now();
  if (enabled) {
    const delta = since !== undefined ? ` (+${(now - since).toFixed(1)} ms)` : '';
    process.stderr.write(`[convpdf ${(now - origin).toFixed(1).padStart(7)} ms] ${label}${delta}\n`);
  }
  return now;
}
