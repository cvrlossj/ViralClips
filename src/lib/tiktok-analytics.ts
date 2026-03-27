// ---------------------------------------------------------------------------
// TikTok Analytics — Scrape trending content to calibrate viral scoring
// ---------------------------------------------------------------------------
// Uses TikTok Scraper7 (tikwm) via RapidAPI to:
// 1. Analyze what's trending in your niche
// 2. Study top-performing clips from any creator
// 3. Build a "viral benchmark" dataset that calibrates our clip scoring
// 4. Track your own published clips' performance over time
//
// Env vars:
//   RAPIDAPI_KEY or RAPIDAPI_KEY_TIKTOK — your RapidAPI key
// ---------------------------------------------------------------------------

import { hasRapidApiKey, rapidApiGetJson } from "@/lib/rapidapi-client";

const API_HOST = "tiktok-scraper7.p.rapidapi.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TikTokVideo = {
  id: string;
  title: string;
  duration: number;
  playCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  collectCount: number;
  downloadCount: number;
  createTime: number;
  coverUrl: string;
  playUrl: string;
  author: {
    id: string;
    uniqueId: string;
    nickname: string;
    avatarUrl: string;
  };
  musicTitle: string;
  isAd: boolean;
};

export type TikTokUserStats = {
  uniqueId: string;
  nickname: string;
  followerCount: number;
  heartCount: number;
  videoCount: number;
  verified: boolean;
};

export type ViralBenchmark = {
  /** Average metrics across analyzed videos */
  avgViews: number;
  avgLikes: number;
  avgShares: number;
  avgComments: number;
  avgDuration: number;
  /** Engagement rate: (likes + comments + shares) / views */
  avgEngagementRate: number;
  /** Duration distribution: what lengths perform best */
  durationBuckets: { range: string; avgViews: number; count: number }[];
  /** Top performing videos for reference */
  topVideos: { id: string; title: string; views: number; duration: number; engagementRate: number }[];
  /** Analyzed at */
  analyzedAt: string;
  /** Total videos analyzed */
  totalAnalyzed: number;
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function canUseTikTok(): boolean {
  return hasRapidApiKey(API_HOST);
}

async function tikTokFetch(endpoint: string, params: Record<string, string>): Promise<unknown> {
  if (!canUseTikTok()) {
    throw new Error("No hay clave RapidAPI disponible para TikTok.");
  }

  const json = await rapidApiGetJson<{ code?: number; msg?: string; data?: unknown }>({
    host: API_HOST,
    endpoint,
    params,
    retries: 1,
  });

  if (json.code !== 0) {
    throw new Error(`TikTok API: ${json.msg ?? "respuesta invalida"}`);
  }

  return json.data ?? {};
}

// ---------------------------------------------------------------------------
// Parse raw API response into our types
// ---------------------------------------------------------------------------

function parseVideo(raw: Record<string, unknown>): TikTokVideo {
  const author = (raw.author ?? {}) as Record<string, unknown>;
  const musicInfo = (raw.music_info ?? {}) as Record<string, unknown>;

  return {
    id: String(raw.id ?? raw.video_id ?? ""),
    title: String(raw.title ?? ""),
    duration: Number(raw.duration ?? 0),
    playCount: Number(raw.play_count ?? 0),
    likeCount: Number(raw.digg_count ?? 0),
    commentCount: Number(raw.comment_count ?? 0),
    shareCount: Number(raw.share_count ?? 0),
    collectCount: Number(raw.collect_count ?? 0),
    downloadCount: Number(raw.download_count ?? 0),
    createTime: Number(raw.create_time ?? 0),
    coverUrl: String(raw.cover ?? raw.origin_cover ?? ""),
    playUrl: String(raw.play ?? ""),
    author: {
      id: String(author.id ?? ""),
      uniqueId: String(author.unique_id ?? ""),
      nickname: String(author.nickname ?? ""),
      avatarUrl: String(author.avatar ?? ""),
    },
    musicTitle: String(musicInfo.title ?? ""),
    isAd: Boolean(raw.is_ad),
  };
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/**
 * Get videos from a specific user's feed.
 * Useful for analyzing what works for creators in your niche.
 */
export async function getUserVideos(
  username: string,
  count = 30,
): Promise<TikTokVideo[]> {
  const data = await tikTokFetch("/user/posts", {
    unique_id: username.replace(/^@/, ""),
    count: String(count),
    cursor: "0",
  }) as { videos?: unknown[] };

  return (data.videos ?? []).map((v) => parseVideo(v as Record<string, unknown>));
}

/**
 * Get user profile stats.
 */
export async function getUserInfo(username: string): Promise<TikTokUserStats> {
  const data = await tikTokFetch("/user/info", {
    unique_id: username.replace(/^@/, ""),
  }) as { user?: Record<string, unknown>; stats?: Record<string, unknown> };

  const user = data.user ?? {};
  const stats = data.stats ?? {};

  return {
    uniqueId: String(user.uniqueId ?? ""),
    nickname: String(user.nickname ?? ""),
    followerCount: Number(stats.followerCount ?? 0),
    heartCount: Number(stats.heartCount ?? 0),
    videoCount: Number(stats.videoCount ?? 0),
    verified: Boolean(user.verified),
  };
}

/**
 * Search for trending videos by keyword.
 * Great for discovering what's viral in your content niche.
 */
export async function searchVideos(
  keywords: string,
  count = 20,
): Promise<TikTokVideo[]> {
  const data = await tikTokFetch("/feed/search", {
    keywords,
    count: String(count),
    cursor: "0",
  }) as { videos?: unknown[] };

  return (data.videos ?? []).map((v) => parseVideo(v as Record<string, unknown>));
}

/**
 * Get details for a specific video by URL.
 */
export async function getVideoDetails(videoUrl: string): Promise<TikTokVideo> {
  const data = await tikTokFetch("/", {
    url: videoUrl,
    hd: "1",
  }) as Record<string, unknown>;

  return parseVideo(data);
}

// ---------------------------------------------------------------------------
// Viral Benchmark Builder
// ---------------------------------------------------------------------------
// Analyzes a set of videos and builds engagement benchmarks.
// This is the core of "learning from real data" —
// we compare our clip scores against real-world performance.
// ---------------------------------------------------------------------------

function engagementRate(v: TikTokVideo): number {
  if (v.playCount === 0) return 0;
  return (v.likeCount + v.commentCount + v.shareCount) / v.playCount;
}

/**
 * Build a viral benchmark from a list of videos.
 * Call this with videos from trending searches or top creators in your niche.
 */
export function buildViralBenchmark(videos: TikTokVideo[]): ViralBenchmark {
  // Filter out ads and zero-view videos
  const valid = videos.filter((v) => !v.isAd && v.playCount > 0 && v.duration > 0);
  if (valid.length === 0) {
    return {
      avgViews: 0, avgLikes: 0, avgShares: 0, avgComments: 0,
      avgDuration: 0, avgEngagementRate: 0,
      durationBuckets: [], topVideos: [],
      analyzedAt: new Date().toISOString(), totalAnalyzed: 0,
    };
  }

  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const avg = (arr: number[]) => sum(arr) / arr.length;

  // Duration buckets: <15s, 15-30s, 30-60s, 60-90s, 90-180s, 180s+
  const buckets = [
    { range: "0-15s", min: 0, max: 15 },
    { range: "15-30s", min: 15, max: 30 },
    { range: "30-60s", min: 30, max: 60 },
    { range: "60-90s", min: 60, max: 90 },
    { range: "90-180s", min: 90, max: 180 },
    { range: "180s+", min: 180, max: Infinity },
  ];

  const durationBuckets = buckets.map(({ range, min, max }) => {
    const inBucket = valid.filter((v) => v.duration >= min && v.duration < max);
    return {
      range,
      avgViews: inBucket.length > 0 ? Math.round(avg(inBucket.map((v) => v.playCount))) : 0,
      count: inBucket.length,
    };
  }).filter((b) => b.count > 0);

  // Top 10 by views
  const sorted = [...valid].sort((a, b) => b.playCount - a.playCount);
  const topVideos = sorted.slice(0, 10).map((v) => ({
    id: v.id,
    title: v.title.slice(0, 100),
    views: v.playCount,
    duration: v.duration,
    engagementRate: Number(engagementRate(v).toFixed(4)),
  }));

  return {
    avgViews: Math.round(avg(valid.map((v) => v.playCount))),
    avgLikes: Math.round(avg(valid.map((v) => v.likeCount))),
    avgShares: Math.round(avg(valid.map((v) => v.shareCount))),
    avgComments: Math.round(avg(valid.map((v) => v.commentCount))),
    avgDuration: Math.round(avg(valid.map((v) => v.duration))),
    avgEngagementRate: Number(avg(valid.map(engagementRate)).toFixed(4)),
    durationBuckets,
    topVideos,
    analyzedAt: new Date().toISOString(),
    totalAnalyzed: valid.length,
  };
}

/**
 * Generate a prompt section for the LLM based on viral benchmarks.
 * This calibrates the clip detection to match real-world performance patterns.
 */
export function buildBenchmarkPromptContext(benchmark: ViralBenchmark): string {
  if (benchmark.totalAnalyzed === 0) return "";

  const bestBucket = [...benchmark.durationBuckets].sort((a, b) => b.avgViews - a.avgViews)[0];

  const lines = [
    `DATOS REALES DE TIKTOK (${benchmark.totalAnalyzed} videos analizados):`,
    `- Duracion con mejor rendimiento: ${bestBucket?.range ?? "N/A"} (promedio ${bestBucket?.avgViews.toLocaleString()} views)`,
    `- Engagement rate promedio: ${(benchmark.avgEngagementRate * 100).toFixed(1)}%`,
    `- Views promedio: ${benchmark.avgViews.toLocaleString()}`,
    `- Likes promedio: ${benchmark.avgLikes.toLocaleString()}`,
    `- Shares promedio: ${benchmark.avgShares.toLocaleString()}`,
    "",
    "DISTRIBUCION DE DURACION vs PERFORMANCE:",
    ...benchmark.durationBuckets.map(
      (b) => `  ${b.range}: ${b.avgViews.toLocaleString()} views promedio (${b.count} videos)`,
    ),
    "",
    "USA ESTOS DATOS PARA CALIBRAR TUS DECISIONES:",
    `- Prioriza clips con duracion cercana a ${bestBucket?.range ?? "30-60s"} (mejor rendimiento real).`,
    "- Un clip con alto engagement rate (likes+comments+shares/views) es mejor que uno con solo muchas views.",
    "- Los clips que generan SHARES son los mas virales — prioriza contenido que la gente quiera compartir.",
  ];

  return lines.join("\n");
}

export { canUseTikTok };
