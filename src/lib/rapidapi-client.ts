type RapidApiParamValue = string | number | boolean | null | undefined;

type RapidApiGetJsonOptions = {
  host: string;
  endpoint: string;
  params?: Record<string, RapidApiParamValue>;
  timeoutMs?: number;
  retries?: number;
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 1;

const HOST_KEYS: Record<string, string | undefined> = {
  "tiktok-scraper7.p.rapidapi.com": process.env.RAPIDAPI_KEY_TIKTOK,
  "youtube138.p.rapidapi.com": process.env.RAPIDAPI_KEY_YOUTUBE,
  "instagram-statistics-api.p.rapidapi.com": process.env.RAPIDAPI_KEY_SOCIAL,
};

function splitPool(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n;]/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export class RapidApiRequestError extends Error {
  readonly host: string;
  readonly endpoint: string;
  readonly statusCode: number;
  readonly responseBody: string;

  constructor(options: {
    host: string;
    endpoint: string;
    statusCode: number;
    responseBody: string;
  }) {
    const { host, endpoint, statusCode } = options;
    super(`RapidAPI ${host}${endpoint} respondio ${statusCode}.`);
    this.name = "RapidApiRequestError";
    this.host = host;
    this.endpoint = endpoint;
    this.statusCode = statusCode;
    this.responseBody = options.responseBody;
  }

  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }

  get isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
}

function getCandidateKeys(host: string): string[] {
  return dedupe([
    HOST_KEYS[host] ?? "",
    process.env.RAPIDAPI_KEY ?? "",
    ...splitPool(process.env.RAPIDAPI_KEY_POOL),
  ].filter(Boolean));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.round(secs * 1_000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithKey(url: string, host: string, key: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "X-RapidAPI-Key": key,
        "X-RapidAPI-Host": host,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithSingleKey<T>(
  key: string,
  options: RapidApiGetJsonOptions & { url: string },
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = options.endpoint;
  const host = options.host;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchWithKey(options.url, host, key, timeoutMs);
      const body = await res.text();

      if (res.ok) {
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new Error(`RapidAPI ${host}${endpoint} devolvio JSON invalido.`);
        }
      }

      const error = new RapidApiRequestError({
        host,
        endpoint,
        statusCode: res.status,
        responseBody: body,
      });

      if (error.isRateLimited && attempt < retries) {
        const retryMs = parseRetryAfter(res.headers.get("retry-after")) ?? (600 * (attempt + 1));
        await sleep(retryMs);
        continue;
      }

      throw error;
    } catch (error) {
      if (error instanceof RapidApiRequestError) {
        throw error;
      }
      if (attempt < retries) {
        await sleep(450 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw new Error(`RapidAPI ${host}${endpoint} fallo tras reintentos.`);
}

export async function rapidApiGetJson<T>(options: RapidApiGetJsonOptions): Promise<T> {
  const keys = getCandidateKeys(options.host);
  if (keys.length === 0) {
    throw new Error(`No hay clave RapidAPI para ${options.host}.`);
  }

  const url = new URL(options.endpoint, `https://${options.host}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }

  let lastError: unknown = null;
  for (const key of keys) {
    try {
      return await requestWithSingleKey<T>(key, { ...options, url: url.toString() });
    } catch (error) {
      lastError = error;
      if (
        error instanceof RapidApiRequestError &&
        (error.isAuthError || error.isRateLimited)
      ) {
        continue;
      }
      throw error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(`RapidAPI ${options.host}${options.endpoint} fallo.`);
}

export function hasRapidApiKey(host: string): boolean {
  return getCandidateKeys(host).length > 0;
}

export function isQuotaLikeError(error: unknown): boolean {
  if (error instanceof RapidApiRequestError) {
    return error.statusCode === 429 || error.statusCode === 403;
  }
  return false;
}

export function toRapidApiMessage(prefix: string, error: unknown): string {
  if (error instanceof RapidApiRequestError) {
    const bodyLower = error.responseBody.toLowerCase();
    if (error.statusCode === 429) {
      return `${prefix} API error: 429 Too Many Requests`;
    }
    if (error.statusCode === 403 && bodyLower.includes("not subscribed")) {
      return `${prefix} API error: 403 Not Subscribed`;
    }
    return `${prefix} API error: ${error.statusCode}`;
  }
  if (error instanceof Error) {
    return `${prefix}: ${error.message}`;
  }
  return `${prefix}: error desconocido`;
}
