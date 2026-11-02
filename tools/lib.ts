import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Lock } from '@zthr/intent';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CONTROL = `${ROOT}control`;
export const JOURNEY_DIR = `${CONTROL}/journeys`;
export const LOCK_FILE = `${CONTROL}/lock.json`;
export const OUT = `${ROOT}evidence-out`;

export function readLock(): Lock {
  return existsSync(LOCK_FILE) ? (JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as Lock) : { cards: {} };
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
