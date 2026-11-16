import { spawn } from 'node:child_process';

/** Open a file or URL with the system's default application (best effort). */
export function openTarget(target: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // no opener available
  }
}
