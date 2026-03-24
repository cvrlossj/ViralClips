import { NextRequest, NextResponse } from "next/server";
import { searchVideos, buildViralBenchmark, canUseTikTok } from "@/lib/tiktok-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tiktok/search
 * Search trending TikTok videos by keyword and return benchmark data.
 * Body: { keywords: string, count?: number }
 */
export async function POST(req: NextRequest) {
  if (!canUseTikTok()) {
    return NextResponse.json(
      { error: "RAPIDAPI_KEY no configurada. Agrega RAPIDAPI_KEY a .env.local" },
      { status: 400 },
    );
  }

  try {
    const body = (await req.json()) as { keywords?: string; count?: number };
    const keywords = String(body.keywords ?? "").trim();
    if (!keywords) {
      return NextResponse.json({ error: "Se requiere 'keywords'." }, { status: 400 });
    }

    const count = Math.min(Math.max(Number(body.count) || 20, 5), 50);
    const videos = await searchVideos(keywords, count);
    const benchmark = buildViralBenchmark(videos);

    return NextResponse.json({
      videos: videos.slice(0, 10).map((v) => ({
        id: v.id,
        title: v.title.slice(0, 120),
        duration: v.duration,
        playCount: v.playCount,
        likeCount: v.likeCount,
        shareCount: v.shareCount,
        commentCount: v.commentCount,
        author: v.author.uniqueId,
        coverUrl: v.coverUrl,
      })),
      benchmark,
      totalFound: videos.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
