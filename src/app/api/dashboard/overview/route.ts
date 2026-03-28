import OpenAI from "openai";
import { NextResponse } from "next/server";
import {
  buildViralBenchmark,
  getUserInfo,
  getUserVideos,
  type TikTokVideo,
} from "@/lib/tiktok-analytics";
import { analyzeYouTubeChannel } from "@/lib/youtube-analytics";
import {
  canUseSocialStats,
  findBestSocialProfile,
  searchSocialProfiles,
  type SocialType,
} from "@/lib/social-analytics";
import { readDashboardCache, writeDashboardCache } from "@/lib/dashboard-cache";
import { toRapidApiMessage } from "@/lib/rapidapi-client";
import { trainAdaptiveScoringFromPlatformReports } from "@/lib/adaptive-learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

const defaults = {
  tiktokHandle: process.env.DASHBOARD_TIKTOK_HANDLE ?? "clipsyefersoncossio",
  youtubeHandle: process.env.DASHBOARD_YOUTUBE_HANDLE ?? "clipsyefersoncossio",
  facebookPageUrl:
    process.env.DASHBOARD_FACEBOOK_PAGE_URL ??
    "https://www.facebook.com/profile.php?id=61585631337441",
  youtubeProvider: normalizeProvider(
    process.env.DASHBOARD_YOUTUBE_PROVIDER,
    ["youtube138", "socialstats"],
    "youtube138",
  ),
  facebookProvider: normalizeProvider(
    process.env.DASHBOARD_FACEBOOK_PROVIDER,
    ["socialstats", "graphapi"],
    "socialstats",
  ),
  facebookQuery: process.env.DASHBOARD_FACEBOOK_QUERY ?? "",
  facebookPageId: process.env.DASHBOARD_FACEBOOK_PAGE_ID ?? "",
};

const OVERVIEW_CACHE_KEY = "overview-v2";

type PlatformName = "tiktok" | "youtube" | "facebook";
type PlatformStatus = "ok" | "partial" | "unavailable";
type ProviderName = "tiktok-scraper7" | "youtube138" | "instagram-statistics-api" | "facebook-graph";

type PlatformReport = {
  platform: PlatformName;
  provider: ProviderName;
  host: string;
  status: PlatformStatus;
  handle: string;
  profileUrl: string;
  note?: string;
  profile?: {
    name: string;
    followers: number;
    totalViews: number;
    videoCount: number;
    verified: boolean;
    avatarUrl?: string;
  };
  metrics?: {
    avgViews: number;
    avgEngagementRate: number;
    bestDuration: string;
    totalAnalyzed: number;
  };
  topVideos: Array<{
    id: string;
    title: string;
    views: number;
    engagementRate: number;
    durationSeconds: number;
    url: string;
    publishedText?: string;
  }>;
  timeline: Array<{
    date: string;
    views: number;
    videos: number;
  }>;
};

type ConnectorStatus = {
  platform: PlatformName;
  provider: ProviderName;
  host: string;
  status: PlatformStatus;
  note: string;
};

type StrategyPayload = {
  summary: string;
  actions: string[];
  experiments: string[];
  compliance: string[];
};

type CacheInfo = {
  source: "live" | "cache" | "stale-fallback";
  ageSeconds: number;
  ttlSeconds: number;
  forced: boolean;
};

type DashboardPayload = {
  generatedAt: string;
  strategySource: "ai" | "heuristic";
  global: {
    avgViewsCrossPlatform: number;
    tiktokEngagement: string;
    tiktokStatus: PlatformStatus;
    youtubeStatus: PlatformStatus;
    facebookStatus: PlatformStatus;
  };
  accounts: {
    tiktok: PlatformReport;
    youtube: PlatformReport;
    facebook: PlatformReport;
  };
  connectors: ConnectorStatus[];
  strategy: StrategyPayload;
  cache?: CacheInfo;
};

function normalizeProvider(value: string | undefined, allowed: string[], fallback: string): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (allowed.includes(normalized)) return normalized;
  return fallback;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveCacheMinutes(youtubeProvider: string, facebookProvider: string): number {
  const configured = clampInt(process.env.DASHBOARD_CACHE_MINUTES, 1800, 15, 10_080);
  const socialUsage = Number(youtubeProvider === "socialstats") + Number(facebookProvider === "socialstats");
  const recommendedFloor = socialUsage >= 2 ? 1_500 : socialUsage === 1 ? 720 : 120;
  return Math.max(configured, recommendedFloor);
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function engagementRate(video: Pick<TikTokVideo, "playCount" | "likeCount" | "commentCount" | "shareCount">): number {
  if (video.playCount <= 0) return 0;
  return (video.likeCount + video.commentCount + video.shareCount) / video.playCount;
}

function strongestDuration(durationBuckets: { range: string; avgViews: number }[]): string {
  if (durationBuckets.length === 0) return "N/A";
  return [...durationBuckets].sort((a, b) => b.avgViews - a.avgViews)[0].range;
}

function dateKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const cl = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (cl) {
    const dd = String(Number(cl[1])).padStart(2, "0");
    const mm = String(Number(cl[2])).padStart(2, "0");
    return `${cl[3]}-${mm}-${dd}`;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return dateKeyFromDate(parsed);
}

function buildTimeline(rows: Array<{ date: string; views: number }>, maxPoints = 10) {
  const map = new Map<string, { views: number; videos: number }>();

  for (const row of rows) {
    if (!row.date || row.views <= 0) continue;
    const current = map.get(row.date) ?? { views: 0, videos: 0 };
    current.views += row.views;
    current.videos += 1;
    map.set(row.date, current);
  }

  return [...map.entries()]
    .map(([date, value]) => ({
      date,
      views: value.views,
      videos: value.videos,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-maxPoints);
}

function guessYoutubeQuery(input: string): string {
  const raw = input.trim();
  if (!raw) return "";
  const fromUrl = raw.match(/youtube\.com\/@([^/?#]+)/i)?.[1];
  if (fromUrl) return fromUrl;
  return raw.replace(/^@/, "");
}

function guessFacebookQuery(pageUrl: string): string {
  const raw = pageUrl.trim();
  if (!raw) return "";
  const profileId = raw.match(/[?&]id=(\d+)/i)?.[1];
  if (profileId) return profileId;
  const pathName = raw.match(/facebook\.com\/([^/?#]+)/i)?.[1];
  if (pathName && pathName.toLowerCase() !== "profile.php") return pathName;
  return raw;
}

function parseFacebookPageId(pageUrl: string): string {
  const fromEnv = String(defaults.facebookPageId ?? "").trim();
  if (fromEnv) return fromEnv;
  const raw = pageUrl.trim();
  if (!raw) return "";
  const fromQuery = raw.match(/[?&]id=(\d+)/i)?.[1];
  if (fromQuery) return fromQuery;
  return "";
}

async function loadTikTokReport(handle: string): Promise<PlatformReport> {
  const clean = handle.replace(/^@/, "");

  try {
    const [user, videos] = await Promise.all([
      getUserInfo(clean),
      getUserVideos(clean, 30),
    ]);
    const benchmark = buildViralBenchmark(videos);

    const topVideos = [...videos]
      .filter((video) => video.playCount > 0)
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 8)
      .map((video) => ({
        id: video.id,
        title: video.title || "Video de TikTok",
        views: video.playCount,
        engagementRate: engagementRate(video),
        durationSeconds: video.duration,
        url: `https://www.tiktok.com/@${clean}/video/${video.id}`,
        publishedText: video.createTime > 0
          ? new Date(video.createTime * 1000).toLocaleDateString("es-CL")
          : undefined,
      }));

    const timeline = buildTimeline(
      videos
        .filter((video) => video.createTime > 0 && video.playCount > 0)
        .map((video) => ({
          date: dateKeyFromDate(new Date(video.createTime * 1000)),
          views: video.playCount,
        })),
      10,
    );

    return {
      platform: "tiktok",
      provider: "tiktok-scraper7",
      host: "tiktok-scraper7.p.rapidapi.com",
      status: "ok",
      handle: `@${clean}`,
      profileUrl: `https://www.tiktok.com/@${clean}`,
      profile: {
        name: user.nickname || clean,
        followers: user.followerCount,
        totalViews: user.heartCount,
        videoCount: user.videoCount,
        verified: user.verified,
      },
      metrics: {
        avgViews: benchmark.avgViews,
        avgEngagementRate: benchmark.avgEngagementRate,
        bestDuration: strongestDuration(benchmark.durationBuckets),
        totalAnalyzed: benchmark.totalAnalyzed,
      },
      topVideos,
      timeline,
    };
  } catch (error) {
    return {
      platform: "tiktok",
      provider: "tiktok-scraper7",
      host: "tiktok-scraper7.p.rapidapi.com",
      status: "unavailable",
      handle: `@${clean}`,
      profileUrl: `https://www.tiktok.com/@${clean}`,
      note: toRapidApiMessage("TikTok", error),
      topVideos: [],
      timeline: [],
    };
  }
}

async function loadYouTubeFromRapid(handle: string): Promise<PlatformReport> {
  try {
    const data = await analyzeYouTubeChannel(handle);
    const topVideos = [...data.videos]
      .filter((video) => video.views > 0 || video.durationSeconds > 0)
      .sort((a, b) => b.views - a.views)
      .slice(0, 8)
      .map((video) => ({
        id: video.id,
        title: video.title,
        views: video.views,
        engagementRate: 0,
        durationSeconds: video.durationSeconds,
        url: video.url,
        publishedText: video.publishedText,
      }));

    const timeline = buildTimeline(
      data.videos
        .map((video) => ({
          date: parseDateKey(video.publishedDate ?? video.publishedText ?? "") ?? "",
          views: video.views,
        })),
      10,
    );

    return {
      platform: "youtube",
      provider: "youtube138",
      host: "youtube138.p.rapidapi.com",
      status: "ok",
      handle: data.channel.username || handle,
      profileUrl: data.channel.channelUrl,
      profile: {
        name: data.channel.title,
        followers: data.channel.subscribers,
        totalViews: data.channel.views,
        videoCount: data.channel.videos,
        verified: data.channel.verified,
        avatarUrl: data.channel.avatarUrl,
      },
      metrics: {
        avgViews: data.benchmark.avgViews,
        avgEngagementRate: 0,
        bestDuration: strongestDuration(data.benchmark.durationBuckets),
        totalAnalyzed: data.benchmark.totalAnalyzed,
      },
      topVideos,
      timeline,
    };
  } catch (error) {
    return {
      platform: "youtube",
      provider: "youtube138",
      host: "youtube138.p.rapidapi.com",
      status: "unavailable",
      handle,
      profileUrl: "https://www.youtube.com",
      note: toRapidApiMessage("YouTube", error),
      topVideos: [],
      timeline: [],
    };
  }
}

async function loadFromSocialSearch(
  query: string,
  socialType: SocialType,
): Promise<{
  found: boolean;
  profile?: {
    handle: string;
    profileUrl: string;
    name: string;
    followers: number;
    totalViews: number;
    videoCount: number;
    avatarUrl?: string;
    engagementRate: number;
  };
}> {
  if (!canUseSocialStats()) {
    throw new Error("No hay clave RapidAPI disponible para instagram-statistics-api.");
  }

  const profiles = await searchSocialProfiles(query, [socialType]);
  const best = findBestSocialProfile(profiles, query, socialType);
  if (!best) {
    return { found: false };
  }

  return {
    found: true,
    profile: {
      handle: best.handle,
      profileUrl: best.url,
      name: best.name,
      followers: best.followers,
      totalViews: best.totalViews,
      videoCount: best.contentCount,
      avatarUrl: best.avatarUrl,
      engagementRate: best.engagementRate,
    },
  };
}

async function loadYouTubeFromSocial(handle: string): Promise<PlatformReport> {
  const query = guessYoutubeQuery(handle);
  const fallbackUrl = `https://www.youtube.com/@${query}`;

  try {
    const result = await loadFromSocialSearch(query, "YT");

    if (!result.found || !result.profile) {
      return {
        platform: "youtube",
        provider: "instagram-statistics-api",
        host: "instagram-statistics-api.p.rapidapi.com",
        status: "partial",
        handle: query,
        profileUrl: fallbackUrl,
        note: "Conector social activo, pero no devolvio perfil YouTube para ese handle.",
        topVideos: [],
        timeline: [],
      };
    }

    return {
      platform: "youtube",
      provider: "instagram-statistics-api",
      host: "instagram-statistics-api.p.rapidapi.com",
      status: "partial",
      handle: result.profile.handle || query,
      profileUrl: result.profile.profileUrl || fallbackUrl,
      note: "Fuente unificada activa: este endpoint entrega perfil/resumen; el detalle de top videos sigue limitado.",
      profile: {
        name: result.profile.name || query,
        followers: result.profile.followers,
        totalViews: result.profile.totalViews,
        videoCount: result.profile.videoCount,
        verified: false,
        avatarUrl: result.profile.avatarUrl,
      },
      metrics: {
        avgViews: 0,
        avgEngagementRate: result.profile.engagementRate,
        bestDuration: "N/A",
        totalAnalyzed: 0,
      },
      topVideos: [],
      timeline: [],
    };
  } catch (error) {
    return {
      platform: "youtube",
      provider: "instagram-statistics-api",
      host: "instagram-statistics-api.p.rapidapi.com",
      status: "unavailable",
      handle: query,
      profileUrl: fallbackUrl,
      note: toRapidApiMessage("YouTube (Social API)", error),
      topVideos: [],
      timeline: [],
    };
  }
}

async function loadYouTubeReport(handle: string, provider: string): Promise<PlatformReport> {
  if (provider === "socialstats") {
    return loadYouTubeFromSocial(handle);
  }
  return loadYouTubeFromRapid(handle);
}

async function loadFacebookReport(pageUrl: string): Promise<PlatformReport> {
  const query = String(defaults.facebookQuery || guessFacebookQuery(pageUrl)).trim();

  try {
    const result = await loadFromSocialSearch(query, "FB");

    if (!result.found || !result.profile) {
      return {
        platform: "facebook",
        provider: "instagram-statistics-api",
        host: "instagram-statistics-api.p.rapidapi.com",
        status: "partial",
        handle: "Facebook Page",
        profileUrl: pageUrl,
        note: "Conector social activo, pero no devolvio perfil Facebook para esta pagina.",
        topVideos: [],
        timeline: [],
      };
    }

    return {
      platform: "facebook",
      provider: "instagram-statistics-api",
      host: "instagram-statistics-api.p.rapidapi.com",
      status: "partial",
      handle: result.profile.handle || "Facebook Page",
      profileUrl: result.profile.profileUrl || pageUrl,
      note: "Conector social activo: para insights de video detallados puede requerirse endpoint adicional del proveedor.",
      profile: {
        name: result.profile.name || "Facebook Page",
        followers: result.profile.followers,
        totalViews: result.profile.totalViews,
        videoCount: result.profile.videoCount,
        verified: false,
        avatarUrl: result.profile.avatarUrl,
      },
      metrics: {
        avgViews: 0,
        avgEngagementRate: result.profile.engagementRate,
        bestDuration: "N/A",
        totalAnalyzed: 0,
      },
      topVideos: [],
      timeline: [],
    };
  } catch (error) {
    return {
      platform: "facebook",
      provider: "instagram-statistics-api",
      host: "instagram-statistics-api.p.rapidapi.com",
      status: "unavailable",
      handle: "Facebook Page",
      profileUrl: pageUrl,
      note: toRapidApiMessage("Facebook", error),
      topVideos: [],
      timeline: [],
    };
  }
}

async function loadFacebookFromGraphApi(pageUrl: string): Promise<PlatformReport> {
  const accessToken = String(process.env.FACEBOOK_ACCESS_TOKEN ?? "").trim();
  const pageId = parseFacebookPageId(pageUrl);
  if (!accessToken) {
    return {
      platform: "facebook",
      provider: "facebook-graph",
      host: "graph.facebook.com",
      status: "unavailable",
      handle: "Facebook Page",
      profileUrl: pageUrl,
      note: "Falta FACEBOOK_ACCESS_TOKEN para usar Graph API oficial.",
      topVideos: [],
      timeline: [],
    };
  }

  if (!pageId) {
    return {
      platform: "facebook",
      provider: "facebook-graph",
      host: "graph.facebook.com",
      status: "unavailable",
      handle: "Facebook Page",
      profileUrl: pageUrl,
      note: "No se pudo detectar ID numerico de pagina de Facebook (usa DASHBOARD_FACEBOOK_PAGE_ID).",
      topVideos: [],
      timeline: [],
    };
  }

  try {
    const url = new URL(`https://graph.facebook.com/v22.0/${pageId}`);
    url.searchParams.set("fields", "id,name,link,followers_count,fan_count");
    url.searchParams.set("access_token", accessToken);

    const res = await fetch(url.toString(), { method: "GET", cache: "no-store" });
    const body = await res.json() as {
      id?: string;
      name?: string;
      link?: string;
      followers_count?: number;
      fan_count?: number;
      error?: { message?: string };
    };

    if (!res.ok || body.error) {
      return {
        platform: "facebook",
        provider: "facebook-graph",
        host: "graph.facebook.com",
        status: "unavailable",
        handle: "Facebook Page",
        profileUrl: pageUrl,
        note: `Graph API error: ${body.error?.message ?? `${res.status}`}`,
        topVideos: [],
        timeline: [],
      };
    }

    return {
      platform: "facebook",
      provider: "facebook-graph",
      host: "graph.facebook.com",
      status: "ok",
      handle: String(body.name ?? "Facebook Page"),
      profileUrl: String(body.link ?? pageUrl),
      note: "Conectado por Graph API oficial de Meta.",
      profile: {
        name: String(body.name ?? "Facebook Page"),
        followers: Number(body.followers_count ?? body.fan_count ?? 0),
        totalViews: 0,
        videoCount: 0,
        verified: false,
      },
      metrics: {
        avgViews: 0,
        avgEngagementRate: 0,
        bestDuration: "N/A",
        totalAnalyzed: 0,
      },
      topVideos: [],
      timeline: [],
    };
  } catch (error) {
    return {
      platform: "facebook",
      provider: "facebook-graph",
      host: "graph.facebook.com",
      status: "unavailable",
      handle: "Facebook Page",
      profileUrl: pageUrl,
      note: toRapidApiMessage("Facebook Graph", error),
      topVideos: [],
      timeline: [],
    };
  }
}

async function loadFacebookWithProvider(pageUrl: string): Promise<PlatformReport> {
  if (defaults.facebookProvider === "graphapi") {
    return loadFacebookFromGraphApi(pageUrl);
  }

  const social = await loadFacebookReport(pageUrl);
  const hasGraphToken = String(process.env.FACEBOOK_ACCESS_TOKEN ?? "").trim().length > 0;
  if (social.status === "ok" || !hasGraphToken) {
    return social;
  }

  const graph = await loadFacebookFromGraphApi(pageUrl);
  if (graph.status === "ok") {
    return graph;
  }
  return social;
}

function shouldUseCachedFallback(report: PlatformReport): boolean {
  if (report.status === "ok") return false;
  const message = String(report.note ?? "").toLowerCase();
  if (message.includes("429") || message.includes("too many requests")) return true;
  if (message.includes("403") || message.includes("not subscribed")) return true;
  return false;
}

function mergeWithCachedReport(
  current: PlatformReport,
  previous: PlatformReport | undefined,
  previousGeneratedAt: string | undefined,
): PlatformReport {
  if (!previous) return current;
  if (current.status === "ok") return current;
  if (!shouldUseCachedFallback(current)) return current;

  const snapshotAt = previousGeneratedAt
    ? new Date(previousGeneratedAt).toLocaleString("es-CL")
    : "snapshot previo";

  return {
    ...previous,
    status: "partial",
    note: `${current.note ?? "Limite de API."} Mostrando ultimo snapshot valido (${snapshotAt}).`,
  };
}

function buildConnector(report: PlatformReport): ConnectorStatus {
  return {
    platform: report.platform,
    provider: report.provider,
    host: report.host,
    status: report.status,
    note: report.note ?? "Conector activo.",
  };
}

function buildHeuristicStrategy(
  tiktok: PlatformReport,
  youtube: PlatformReport,
  facebook: PlatformReport,
): StrategyPayload {
  const candidates = [tiktok, youtube].filter((report) => report.status !== "unavailable" && report.metrics);
  const leader = [...candidates].sort((a, b) => (b.metrics?.avgViews ?? 0) - (a.metrics?.avgViews ?? 0))[0];
  const leaderName = leader?.platform.toUpperCase() ?? "TIKTOK/YOUTUBE";
  const leaderViews = leader?.metrics?.avgViews ?? 0;
  const facebookLine =
    facebook.status === "ok" || facebook.status === "partial"
      ? "Integra Facebook en el loop de publicacion aunque la data de videos sea parcial."
      : "Facebook aun no entrega datos estables: valida suscripcion/endpoint antes de depender de esa señal.";

  return {
    summary: leader
      ? `${leaderName} lidera por promedio de vistas (${leaderViews.toLocaleString()}). Replica su patron base y ajusta hooks por plataforma.`
      : "No hay suficientes datos para elegir un lider. Prioriza estabilizar conectores y acumular muestra.",
    actions: [
      `Prioriza clips en rango ${tiktok.metrics?.bestDuration ?? youtube.metrics?.bestDuration ?? "30-60s"} durante 7 dias.`,
      "Duplica variantes del top 20% de temas (mismo tema, hook distinto en 2-3s iniciales).",
      "Publica en una ventana horaria fija y compara retencion por franja durante una semana.",
    ],
    experiments: [
      "A/B test de 2 hooks por clip (curiosidad vs conflicto).",
      "A/B test de ritmo de corte: 1.2s vs 1.8s para medir completion rate.",
      "Cross-post secuencial: TikTok primero, luego YouTube/Facebook con copy adaptado.",
    ],
    compliance: [
      facebookLine,
      "No uses tecnicas para evadir deteccion de copyright o politicas de plataforma.",
      "Trabaja con material autorizado y aporta transformacion real (edicion, contexto, analisis).",
      "Monitorea strikes y excluye fuentes con historial de reclamos.",
    ],
  };
}

async function buildAiStrategy(
  tiktok: PlatformReport,
  youtube: PlatformReport,
  facebook: PlatformReport,
): Promise<{ strategy: StrategyPayload; source: "ai" | "heuristic" }> {
  const fallback = buildHeuristicStrategy(tiktok, youtube, facebook);
  if (!OPENAI_API_KEY) {
    return { strategy: fallback, source: "heuristic" };
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    const compact = {
      generatedAt: new Date().toISOString(),
      tiktok: tiktok.metrics,
      youtube: youtube.metrics,
      facebook: { status: facebook.status, note: facebook.note },
      topTiktok: tiktok.topVideos.slice(0, 5).map((video) => ({
        title: video.title,
        views: video.views,
        er: video.engagementRate,
      })),
      topYoutube: youtube.topVideos.slice(0, 5).map((video) => ({
        title: video.title,
        views: video.views,
      })),
    };

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 450,
      messages: [
        {
          role: "system",
          content: [
            "Eres estratega senior de contenido short-form.",
            "Devuelve SOLO JSON valido con este shape:",
            "{",
            "\"summary\": string,",
            "\"actions\": string[3],",
            "\"experiments\": string[3],",
            "\"compliance\": string[3]",
            "}",
            "No sugieras evasion de deteccion ni infraccion de derechos de autor.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Analiza estos datos y da estrategia accionable para 7 dias:\n${JSON.stringify(compact)}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { strategy: fallback, source: "heuristic" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<StrategyPayload>;
    if (
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.actions) ||
      !Array.isArray(parsed.experiments) ||
      !Array.isArray(parsed.compliance)
    ) {
      return { strategy: fallback, source: "heuristic" };
    }

    return {
      strategy: {
        summary: parsed.summary,
        actions: parsed.actions.slice(0, 3).map((item) => String(item)),
        experiments: parsed.experiments.slice(0, 3).map((item) => String(item)),
        compliance: parsed.compliance.slice(0, 4).map((item) => String(item)),
      },
      source: "ai",
    };
  } catch {
    return { strategy: fallback, source: "heuristic" };
  }
}

function buildCacheInfo(source: CacheInfo["source"], ageMs: number, ttlMs: number, forced: boolean): CacheInfo {
  return {
    source,
    ageSeconds: Math.max(0, Math.round(ageMs / 1_000)),
    ttlSeconds: Math.max(1, Math.round(ttlMs / 1_000)),
    forced,
  };
}

function withCacheMeta(payload: DashboardPayload, cache: CacheInfo): DashboardPayload {
  return {
    ...payload,
    cache,
  };
}

async function updateAdaptiveScoring(
  reports: PlatformReport[],
  force: boolean,
): Promise<void> {
  try {
    await trainAdaptiveScoringFromPlatformReports(
      reports.map((report) => ({
        platform: report.platform,
        status: report.status,
        topVideos: report.topVideos.map((video) => ({
          views: video.views,
          durationSeconds: video.durationSeconds,
          engagementRate: video.engagementRate,
        })),
        timeline: report.timeline,
      })),
      { force },
    );
  } catch {
    // Keep dashboard response resilient even if adaptive training fails.
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const forceRefresh = ["1", "true", "yes"].includes(
    String(url.searchParams.get("refresh") ?? url.searchParams.get("force") ?? "").toLowerCase(),
  );

  const cacheMinutes = resolveCacheMinutes(defaults.youtubeProvider, defaults.facebookProvider);
  const cacheTtlMs = cacheMinutes * 60_000;
  const cached = await readDashboardCache<DashboardPayload>(OVERVIEW_CACHE_KEY);

  if (cached && !cached.stale && !forceRefresh) {
    await updateAdaptiveScoring(
      [cached.data.accounts.tiktok, cached.data.accounts.youtube, cached.data.accounts.facebook],
      false,
    );
    return NextResponse.json(
      withCacheMeta(
        cached.data,
        buildCacheInfo("cache", cached.ageMs, cacheTtlMs, false),
      ),
    );
  }

  const tiktokHandle = defaults.tiktokHandle.replace(/^@/, "");
  const youtubeHandle = defaults.youtubeHandle.replace(/^@/, "");

  const [rawTikTok, rawYouTube, rawFacebook] = await Promise.all([
    loadTikTokReport(tiktokHandle),
    loadYouTubeReport(youtubeHandle, defaults.youtubeProvider),
    loadFacebookWithProvider(defaults.facebookPageUrl),
  ]);

  const previous = cached?.data.accounts;
  const previousGeneratedAt = cached?.data.generatedAt;

  const tiktok = mergeWithCachedReport(rawTikTok, previous?.tiktok, previousGeneratedAt);
  const youtube = mergeWithCachedReport(rawYouTube, previous?.youtube, previousGeneratedAt);
  const facebook = mergeWithCachedReport(rawFacebook, previous?.facebook, previousGeneratedAt);

  const allUnavailable = [tiktok, youtube, facebook].every((report) => report.status === "unavailable");
  if (allUnavailable && cached?.data) {
    await updateAdaptiveScoring(
      [cached.data.accounts.tiktok, cached.data.accounts.youtube, cached.data.accounts.facebook],
      false,
    );
    return NextResponse.json(
      withCacheMeta(
        cached.data,
        buildCacheInfo("stale-fallback", cached.ageMs, cacheTtlMs, forceRefresh),
      ),
    );
  }

  const { strategy, source } = await buildAiStrategy(tiktok, youtube, facebook);

  const global = {
    avgViewsCrossPlatform: Math.round(
      [tiktok.metrics?.avgViews ?? 0, youtube.metrics?.avgViews ?? 0]
        .filter((value) => value > 0)
        .reduce((acc, value, _index, arr) => acc + value / arr.length, 0),
    ),
    tiktokEngagement: formatPct(tiktok.metrics?.avgEngagementRate ?? 0),
    tiktokStatus: tiktok.status,
    youtubeStatus: youtube.status,
    facebookStatus: facebook.status,
  };

  const payload: DashboardPayload = {
    generatedAt: new Date().toISOString(),
    strategySource: source,
    global,
    accounts: { tiktok, youtube, facebook },
    connectors: [buildConnector(tiktok), buildConnector(youtube), buildConnector(facebook)],
    strategy,
  };

  await writeDashboardCache(OVERVIEW_CACHE_KEY, payload, cacheTtlMs);
  await updateAdaptiveScoring([tiktok, youtube, facebook], forceRefresh);

  return NextResponse.json(
    withCacheMeta(payload, buildCacheInfo("live", 0, cacheTtlMs, forceRefresh)),
  );
}



