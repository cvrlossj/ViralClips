import { hasRapidApiKey, rapidApiGetJson } from "@/lib/rapidapi-client";

const API_HOST = "youtube138.p.rapidapi.com";

export type YouTubeVideo = {
  id: string;
  title: string;
  views: number;
  durationSeconds: number;
  publishedText: string;
  publishedDate?: string;
  thumbnailUrl: string;
  url: string;
};

export type YouTubeChannel = {
  channelId: string;
  title: string;
  username: string;
  avatarUrl: string;
  subscribers: number;
  videos: number;
  views: number;
  verified: boolean;
  channelUrl: string;
};

export type YouTubeBenchmark = {
  avgViews: number;
  avgDuration: number;
  totalAnalyzed: number;
  durationBuckets: { range: string; avgViews: number; count: number }[];
  topVideos: { id: string; title: string; views: number; duration: number }[];
};

type YouTubeChannelAnalysis = {
  channel: YouTubeChannel;
  videos: YouTubeVideo[];
  benchmark: YouTubeBenchmark;
};

type SearchChannelItem = {
  type?: string;
  channel?: {
    channelId?: string;
    title?: string;
    username?: string;
    canonicalBaseUrl?: string;
  };
};

function canUseYouTubeRapidApi(): boolean {
  return hasRapidApiKey(API_HOST);
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const direct = Number(trimmed.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(direct) && !/[kKmMbB]$/.test(trimmed)) return Math.max(0, direct);
    const suffixMatch = trimmed.match(/^([\d.]+)\s*([kKmMbB])$/);
    if (!suffixMatch) return Number.isFinite(direct) ? Math.max(0, direct) : 0;
    const base = Number(suffixMatch[1]);
    const suffix = suffixMatch[2].toLowerCase();
    const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1_000_000_000;
    return Number.isFinite(base) ? Math.max(0, Math.round(base * mult)) : 0;
  }
  return 0;
}

function normalizeQuery(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const fromUrl = raw.match(/youtube\.com\/@([^/?#]+)/i)?.[1];
  if (fromUrl) return fromUrl;
  return raw.replace(/^@/, "");
}

function norm(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function searchScore(item: SearchChannelItem, targetHandle: string): number {
  const channel = item.channel ?? {};
  const target = norm(targetHandle);
  const username = norm(String(channel.username ?? ""));
  const title = String(channel.title ?? "").toLowerCase();
  const canonical = String(channel.canonicalBaseUrl ?? "").toLowerCase();
  const canonicalHandle = norm(canonical.replace(/^\/@/, ""));
  const channelId = String(channel.channelId ?? "");

  let score = 0;
  if (username && username === target) score += 300;
  if (canonicalHandle && canonicalHandle === target) score += 280;
  if (canonical.includes(`/@${target}`)) score += 230;
  if (title.includes(target)) score += 70;
  if (channelId) score += 5;
  return score;
}

async function ytFetch(endpoint: string, params: Record<string, string>): Promise<unknown> {
  if (!canUseYouTubeRapidApi()) {
    throw new Error("No hay clave RapidAPI disponible para YouTube.");
  }

  return rapidApiGetJson({
    host: API_HOST,
    endpoint,
    params,
    retries: 1,
  });
}

async function searchChannelId(query: string): Promise<string> {
  const target = norm(query);
  const searches = Array.from(new Set([`@${target}`, target, `"${target}"`]));

  let best: { id: string; score: number } | null = null;
  let firstId: string | null = null;

  for (const term of searches) {
    const data = await ytFetch("/search/", {
      q: term,
      type: "channel",
      hl: "es",
      gl: "CL",
    }) as { contents?: SearchChannelItem[] };

    const channels = (data.contents ?? []).filter((item) => item.type === "channel" && item.channel?.channelId);
    if (!firstId && channels[0]?.channel?.channelId) {
      firstId = channels[0].channel.channelId;
    }

    for (const item of channels) {
      const id = String(item.channel?.channelId ?? "");
      if (!id) continue;
      const score = searchScore(item, target);
      if (!best || score > best.score) {
        best = { id, score };
      }
    }
  }

  if (best && best.score >= 220) {
    return best.id;
  }
  if (firstId) {
    return firstId;
  }
  if (!firstId) {
    throw new Error("No se encontro canal de YouTube para ese handle.");
  }
  return firstId;
}

async function getChannel(channelId: string): Promise<YouTubeChannel> {
  const data = await ytFetch("/channel/details/", {
    id: channelId,
    hl: "es",
    gl: "CL",
  }) as {
    channelId?: string;
    title?: string;
    username?: string;
    avatar?: Array<{ url?: string }>;
    isVerified?: boolean;
    canonicalBaseUrl?: string;
    stats?: { subscribers?: unknown; videos?: unknown; views?: unknown };
  };

  const username = String(data.username ?? "");
  const baseUrl = data.canonicalBaseUrl
    ? `https://www.youtube.com${String(data.canonicalBaseUrl)}`
    : username
      ? `https://www.youtube.com/${username}`
      : `https://www.youtube.com/channel/${channelId}`;

  return {
    channelId,
    title: String(data.title ?? "Canal de YouTube"),
    username,
    avatarUrl: String(data.avatar?.[0]?.url ?? ""),
    subscribers: toNumber(data.stats?.subscribers),
    videos: toNumber(data.stats?.videos),
    views: toNumber(data.stats?.views),
    verified: Boolean(data.isVerified),
    channelUrl: baseUrl,
  };
}

async function getVideos(channelId: string, limit = 20): Promise<YouTubeVideo[]> {
  const data = await ytFetch("/channel/videos/", {
    id: channelId,
    hl: "es",
    gl: "CL",
  }) as {
    contents?: Array<{
      type?: string;
      video?: {
        videoId?: string;
        title?: string;
        lengthSeconds?: unknown;
        publishedTimeText?: string;
        thumbnails?: Array<{ url?: string }>;
        stats?: { views?: unknown };
      };
    }>;
  };

  const videos = (data.contents ?? [])
    .filter((item) => item.type === "video" && item.video?.videoId)
    .slice(0, limit)
    .map((item) => {
      const video = item.video ?? {};
      const id = String(video.videoId ?? "");
      return {
        id,
        title: String(video.title ?? "Video de YouTube"),
        views: toNumber(video.stats?.views),
        durationSeconds: toNumber(video.lengthSeconds),
        publishedText: String(video.publishedTimeText ?? ""),
        thumbnailUrl: String(video.thumbnails?.[0]?.url ?? ""),
        url: `https://www.youtube.com/watch?v=${id}`,
      };
    });

  return hydrateVideosWithDetails(videos, Math.min(limit, 15));
}

function parsePublishedTextFromDate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  return parsed.toLocaleDateString("es-CL");
}

async function getVideoDetailsMetrics(videoId: string): Promise<{
  views: number;
  durationSeconds: number;
  publishedText: string;
  publishedDate?: string;
}> {
  const data = await ytFetch("/video/details/", {
    id: videoId,
    hl: "es",
    gl: "CL",
  }) as {
    lengthSeconds?: unknown;
    publishedDate?: string;
    stats?: {
      views?: unknown;
      viewCount?: unknown;
      viewCountText?: string;
      shortViewCountText?: string;
    };
  };

  const views = toNumber(
    data.stats?.views
      ?? data.stats?.viewCount
      ?? data.stats?.shortViewCountText
      ?? data.stats?.viewCountText,
  );
  const durationSeconds = toNumber(data.lengthSeconds);
  const publishedDate = String(data.publishedDate ?? "").trim();
  const publishedText = parsePublishedTextFromDate(publishedDate);

  return {
    views,
    durationSeconds,
    publishedText,
    publishedDate: publishedDate || undefined,
  };
}

async function hydrateVideosWithDetails(videos: YouTubeVideo[], maxDetails: number): Promise<YouTubeVideo[]> {
  const candidates = videos
    .slice(0, maxDetails)
    .filter((video) => video.id);

  if (candidates.length === 0) {
    return videos;
  }

  const details = await Promise.allSettled(
    candidates.map((video) => getVideoDetailsMetrics(video.id)),
  );

  const map = new Map<string, { views: number; durationSeconds: number; publishedText: string; publishedDate?: string }>();
  for (let i = 0; i < candidates.length; i += 1) {
    const result = details[i];
    if (result.status === "fulfilled") {
      map.set(candidates[i].id, result.value);
    }
  }

  return videos.map((video) => {
    const detail = map.get(video.id);
    if (!detail) return video;
    return {
      ...video,
      views: detail.views > 0 ? detail.views : video.views,
      durationSeconds: detail.durationSeconds > 0 ? detail.durationSeconds : video.durationSeconds,
      publishedText: detail.publishedText || video.publishedText,
      publishedDate: detail.publishedDate || video.publishedDate,
    };
  });
}

function buildBenchmark(videos: YouTubeVideo[]): YouTubeBenchmark {
  const valid = videos.filter((v) => v.views > 0 && v.durationSeconds > 0);
  if (valid.length === 0) {
    return {
      avgViews: 0,
      avgDuration: 0,
      totalAnalyzed: 0,
      durationBuckets: [],
      topVideos: [],
    };
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const buckets = [
    { range: "0-15s", min: 0, max: 15 },
    { range: "15-30s", min: 15, max: 30 },
    { range: "30-60s", min: 30, max: 60 },
    { range: "60-90s", min: 60, max: 90 },
    { range: "90s+", min: 90, max: Infinity },
  ];

  const durationBuckets = buckets
    .map(({ range, min, max }) => {
      const inBucket = valid.filter((v) => v.durationSeconds >= min && v.durationSeconds < max);
      return {
        range,
        avgViews: inBucket.length > 0 ? Math.round(avg(inBucket.map((v) => v.views))) : 0,
        count: inBucket.length,
      };
    })
    .filter((b) => b.count > 0);

  const topVideos = [...valid]
    .sort((a, b) => b.views - a.views)
    .slice(0, 10)
    .map((v) => ({
      id: v.id,
      title: v.title.slice(0, 110),
      views: v.views,
      duration: v.durationSeconds,
    }));

  return {
    avgViews: Math.round(avg(valid.map((v) => v.views))),
    avgDuration: Math.round(avg(valid.map((v) => v.durationSeconds))),
    totalAnalyzed: valid.length,
    durationBuckets,
    topVideos,
  };
}

export async function analyzeYouTubeChannel(channelInput: string): Promise<YouTubeChannelAnalysis> {
  const query = normalizeQuery(channelInput);
  if (!query) {
    throw new Error("Handle/URL de YouTube vacio.");
  }

  const channelId = await searchChannelId(query);
  const [channel, videos] = await Promise.all([
    getChannel(channelId),
    getVideos(channelId, 30),
  ]);

  return {
    channel,
    videos,
    benchmark: buildBenchmark(videos),
  };
}

export { canUseYouTubeRapidApi };
