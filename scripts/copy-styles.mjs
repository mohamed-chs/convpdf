import { mkdir, readdir, copyFile } from 'fs/promises';
import { resolve, join } from 'path';

const sourceDir = resolve('src/styles');
const destinationDir = resolve('dist/src/styles');
const toErrorMessage = (error) => (error instanceof Error ? error.message : String(error));

try {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const cssFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.css'));

  if (!cssFiles.length) {
    throw new Error(`No CSS files found in "${sourceDir}".`);
  }

  await Promise.all(
    cssFiles.map((entry) => copyFile(join(sourceDir, entry.name), join(destinationDir, entry.name)))
  );
} catch (error) {
  const message = toErrorMessage(error);
  throw new Error(`Failed to copy style assets: ${message}`, { cause: error });
}
