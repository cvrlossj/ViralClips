import fs from "node:fs/promises";
import path from "node:path";
import { storageRoot } from "@/lib/paths";

type CacheEnvelope<T> = {
  version: 1;
  key: string;
  cachedAt: string;
  expiresAt: string;
  data: T;
};

export type DashboardCacheHit<T> = {
  data: T;
  cachedAt: string;
  expiresAt: string;
  ageMs: number;
  stale: boolean;
};

const cacheDir = path.join(storageRoot, "dashboard");
const memoryCache = new Map<string, CacheEnvelope<unknown>>();

function sanitizeKey(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function fileForKey(key: string): string {
  return path.join(cacheDir, `${sanitizeKey(key)}.json`);
}

function buildHit<T>(envelope: CacheEnvelope<T>): DashboardCacheHit<T> {
  const now = Date.now();
  const cachedAtMs = Date.parse(envelope.cachedAt);
  const expiresAtMs = Date.parse(envelope.expiresAt);
  const ageMs = Number.isFinite(cachedAtMs) ? Math.max(0, now - cachedAtMs) : 0;
  const stale = Number.isFinite(expiresAtMs) ? now > expiresAtMs : true;
  return {
    data: envelope.data,
    cachedAt: envelope.cachedAt,
    expiresAt: envelope.expiresAt,
    ageMs,
    stale,
  };
}

async function readFromDisk<T>(key: string): Promise<CacheEnvelope<T> | null> {
  try {
    const raw = await fs.readFile(fileForKey(key), "utf-8");
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || parsed.version !== 1 || parsed.key !== key) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readDashboardCache<T>(key: string): Promise<DashboardCacheHit<T> | null> {
  const fromMemory = memoryCache.get(key) as CacheEnvelope<T> | undefined;
  if (fromMemory) {
    return buildHit(fromMemory);
  }

  const fromDisk = await readFromDisk<T>(key);
  if (!fromDisk) return null;
  memoryCache.set(key, fromDisk as CacheEnvelope<unknown>);
  return buildHit(fromDisk);
}

export async function writeDashboardCache<T>(key: string, data: T, ttlMs: number): Promise<void> {
  const now = Date.now();
  const envelope: CacheEnvelope<T> = {
    version: 1,
    key,
    cachedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(ttlMs, 1_000)).toISOString(),
    data,
  };

  memoryCache.set(key, envelope as CacheEnvelope<unknown>);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(fileForKey(key), JSON.stringify(envelope, null, 2), "utf-8");
}
