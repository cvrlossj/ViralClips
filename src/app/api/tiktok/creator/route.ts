import { NextRequest, NextResponse } from "next/server";
import {
  getUserVideos,
  getUserInfo,
  buildViralBenchmark,
  canUseTikTok,
} from "@/lib/tiktok-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tiktok/creator
 * Analyze a TikTok creator's content and build engagement benchmarks.
 * Body: { username: string, count?: number }
 */
export async function POST(req: NextRequest) {
  if (!canUseTikTok()) {
    return NextResponse.json(
      { error: "RAPIDAPI_KEY no configurada. Agrega RAPIDAPI_KEY a .env.local" },
      { status: 400 },
    );
  }

  try {
    const body = (await req.json()) as { username?: string; count?: number };
    const username = String(body.username ?? "").trim().replace(/^@/, "");
    if (!username) {
      return NextResponse.json({ error: "Se requiere 'username'." }, { status: 400 });
    }

    const count = Math.min(Math.max(Number(body.count) || 30, 5), 50);

    const [userInfo, videos] = await Promise.all([
      getUserInfo(username),
      getUserVideos(username, count),
    ]);

    const benchmark = buildViralBenchmark(videos);

    return NextResponse.json({
      creator: userInfo,
      videos: videos.slice(0, 10).map((v) => ({
        id: v.id,
        title: v.title.slice(0, 120),
        duration: v.duration,
        playCount: v.playCount,
        likeCount: v.likeCount,
        shareCount: v.shareCount,
        commentCount: v.commentCount,
        coverUrl: v.coverUrl,
      })),
      benchmark,
      totalAnalyzed: videos.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
