import { hasRapidApiKey, rapidApiGetJson } from "@/lib/rapidapi-client";

export type SocialType = "FB" | "YT" | "INST" | "TT";

export type SocialProfile = {
  id: string;
  socialType: string;
  handle: string;
  name: string;
  url: string;
  avatarUrl: string;
  followers: number;
  totalViews: number;
  contentCount: number;
  engagementRate: number;
};

const API_HOST = "instagram-statistics-api.p.rapidapi.com";

function normalizeSocialType(raw: string): SocialType | "" {
  const value = raw.trim().toUpperCase();
  if (value === "YT" || value === "YOUTUBE") return "YT";
  if (value === "FB" || value === "FACEBOOK") return "FB";
  if (value === "INST" || value === "INSTAGRAM" || value === "IG") return "INST";
  if (value === "TT" || value === "TIKTOK") return "TT";
  return "";
}

function isSocialType(value: SocialType | ""): value is SocialType {
  return value === "YT" || value === "FB" || value === "INST" || value === "TT";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.trim();
    if (!cleaned) return 0;
    const direct = Number(cleaned.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(direct) && !/[kKmMbB]$/.test(cleaned)) {
      return Math.max(0, Math.round(direct));
    }
    const compact = cleaned.match(/^([\d.]+)\s*([kKmMbB])$/);
    if (compact) {
      const base = Number(compact[1]);
      const suffix = compact[2].toLowerCase();
      const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1_000_000_000;
      if (Number.isFinite(base)) {
        return Math.max(0, Math.round(base * mult));
      }
    }
    if (Number.isFinite(direct)) return Math.max(0, Math.round(direct));
  }
  return 0;
}

function extractRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map((item) => asRecord(item));
  }

  const root = asRecord(payload);
  const direct = [
    ...asArray(root.items),
    ...asArray(root.results),
    ...asArray(root.data),
    ...asArray(root.accounts),
    ...asArray(root.profiles),
    ...asArray(root.users),
    ...asArray(root.list),
    ...asArray(asRecord(root.data).items),
    ...asArray(asRecord(root.data).results),
  ];

  if (direct.length > 0) {
    return direct.map((item) => asRecord(item));
  }

  for (const value of Object.values(root)) {
    if (Array.isArray(value)) {
      return value.map((item) => asRecord(item));
    }
  }

  return [];
}

function parseProfile(rawValue: unknown): SocialProfile {
  const raw = asRecord(rawValue);
  const stats = asRecord(raw.stats);

  const id = firstString(raw, ["id", "_id", "uuid", "socialId"]);
  const socialType = firstString(raw, ["socialType", "social_type", "platform", "network"]).toUpperCase();
  const handle = firstString(raw, [
    "username",
    "uniqueId",
    "unique_id",
    "userName",
    "screen_name",
    "screenName",
    "handle",
    "slug",
  ]);
  const name = firstString(raw, ["name", "title", "fullName", "full_name", "nickname"]) || handle || "Cuenta";
  const url = firstString(raw, ["url", "profileUrl", "profile_url", "link", "pageUrl", "socialUrl"]);
  const avatarUrl = firstString(raw, ["avatar", "avatarUrl", "avatar_url", "image", "photo", "picture"]);

  const followers = toNumber(raw.followers ?? raw.followersCount ?? raw.subscribers ?? stats.followers ?? stats.subscribers);
  const totalViews = toNumber(raw.views ?? raw.totalViews ?? raw.playCount ?? stats.views ?? stats.totalViews);
  const contentCount = toNumber(raw.posts ?? raw.postsCount ?? raw.videoCount ?? raw.videos ?? stats.posts ?? stats.videoCount);
  const engagementRateRaw = raw.engagementRate ?? raw.er ?? stats.engagementRate ?? stats.er;
  const engagementRate = typeof engagementRateRaw === "number"
    ? engagementRateRaw
    : Number(String(engagementRateRaw ?? "").replace("%", "").trim()) / 100;

  return {
    id,
    socialType,
    handle,
    name,
    url,
    avatarUrl,
    followers,
    totalViews,
    contentCount,
    engagementRate: Number.isFinite(engagementRate) && engagementRate > 0 ? engagementRate : 0,
  };
}

function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, "").toLowerCase();
}

function extractHandleFromUrl(url: string): string {
  const clean = url.trim();
  if (!clean) return "";
  const yt = clean.match(/youtube\.com\/@([^/?#]+)/i)?.[1];
  if (yt) return normalizeHandle(yt);
  const tt = clean.match(/tiktok\.com\/@([^/?#]+)/i)?.[1];
  if (tt) return normalizeHandle(tt);
  const fbSlug = clean.match(/facebook\.com\/([^/?#]+)/i)?.[1];
  if (fbSlug && fbSlug.toLowerCase() !== "profile.php") return normalizeHandle(fbSlug);
  return "";
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function isNumeric(text: string): boolean {
  return /^[0-9]+$/.test(text.trim());
}

export function canUseSocialStats(): boolean {
  return hasRapidApiKey(API_HOST);
}

export async function searchSocialProfiles(query: string, socialTypes: SocialType[]): Promise<SocialProfile[]> {
  const normalized = normalizeHandle(query);
  if (!normalized) {
    return [];
  }

  const data = await rapidApiGetJson<unknown>({
    host: API_HOST,
    endpoint: "/search",
    params: {
      query: normalized,
      q: normalized,
      keywords: normalized,
      page: 1,
      perPage: 12,
      sort: "-score",
      trackTotal: true,
      socialTypes: socialTypes.join(","),
    },
    retries: 1,
  });

  const rows = extractRows(data);
  return rows
    .map((raw) => parseProfile(raw))
    .filter((profile) => {
      if (!profile.id && !profile.handle && !profile.url) return false;
      if (socialTypes.length === 0) return true;
      const normalized = normalizeSocialType(profile.socialType);
      if (!isSocialType(normalized)) return true;
      return socialTypes.includes(normalized);
    });
}

export function findBestSocialProfile(
  profiles: SocialProfile[],
  expectedHandle: string,
  expectedSocialType: SocialType,
): SocialProfile | null {
  if (profiles.length === 0) return null;
  const target = normalizeHandle(expectedHandle);
  const targetTokens = tokenize(target);
  const targetIsNumeric = isNumeric(target);

  const sameType = profiles.filter((profile) => {
    const type = normalizeSocialType(profile.socialType);
    return type.length === 0 || type === expectedSocialType;
  });
  const pool = sameType.length > 0 ? sameType : profiles;

  let best: { profile: SocialProfile; score: number } | null = null;

  for (const profile of pool) {
    const handle = normalizeHandle(profile.handle);
    const url = profile.url.toLowerCase();
    const urlHandle = extractHandleFromUrl(profile.url);
    const name = profile.name.toLowerCase();
    const scoreParts: number[] = [];

    if (handle && handle === target) scoreParts.push(300);
    if (urlHandle && urlHandle === target) scoreParts.push(280);
    if (target && url.includes(target)) scoreParts.push(200);
    if (targetIsNumeric && profile.id.includes(target)) scoreParts.push(260);

    if (!targetIsNumeric && targetTokens.length > 0) {
      const matchedTokens = targetTokens.filter((token) => name.includes(token) || url.includes(token));
      const tokenScore = matchedTokens.length * 28;
      if (tokenScore > 0) scoreParts.push(tokenScore);
    }

    const score = scoreParts.reduce((a, b) => a + b, 0);
    if (!best || score > best.score) {
      best = { profile, score };
    }
  }

  if (!best) return null;
  return best.score >= 220 ? best.profile : null;
}
