import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.somewhere');
const DEVICE_PATH = join(CONFIG_DIR, 'device.json');

interface DeviceFile {
  id: string;
  created_at: string;
}

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadDevice(): DeviceFile | null {
  if (!existsSync(DEVICE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(DEVICE_PATH, 'utf-8')) as DeviceFile;
    if (typeof parsed.id !== 'string' || parsed.id.length < 8) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveDevice(device: DeviceFile): void {
  ensureDir();
  writeFileSync(DEVICE_PATH, JSON.stringify(device, null, 2) + '\n', { mode: 0o600 });
}

export function getDeviceId(): string {
  const existing = loadDevice();
  if (existing) return existing.id;
  const fresh: DeviceFile = { id: randomUUID(), created_at: new Date().toISOString() };
  saveDevice(fresh);
  return fresh.id;
}

function safeHostname(): string {
  const raw = hostname() || 'unknown';
  return raw
    .replace(/\.local$/i, '')
    .replace(/[^A-Za-z0-9_\-]/g, '-')
    .slice(0, 32) || 'unknown';
}

export function getDeviceKeyName(): string {
  const id = getDeviceId();
  const short = id.replace(/-/g, '').slice(0, 8);
  return `CLI \u00b7 ${safeHostname()} \u00b7 ${short}`;
}
