import { NextResponse } from "next/server";
import { z } from "zod";
import { assertFfmpegInstalled } from "@/lib/ffmpeg";
import { processVideo } from "@/lib/video-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const booleanPreprocess = z.preprocess((value) => {
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value;
}, z.boolean());

const formSchema = z.object({
  title: z.string().trim().max(80).default("Momento viral"),
  watermark: z.string().trim().max(50).default("@TuCanal"),
  clips: z.coerce.number().int().min(1).max(12).default(6),
  clipDuration: z.coerce.number().int().min(8).max(90).default(28),
  subtitleSize: z.coerce.number().int().min(16).max(40).default(24),
  smartMode: booleanPreprocess.default(true),
  splitScreen: booleanPreprocess.default(false),
  autoTitle: booleanPreprocess.default(false),
});

export async function POST(request: Request) {
  try {
    await assertFfmpegInstalled();

    const formData = await request.formData();
    const video = formData.get("video");

    if (!(video instanceof File)) {
      return NextResponse.json(
        { error: "Debes adjuntar un video valido." },
        { status: 400 },
      );
    }

    const payload = formSchema.parse({
      title: formData.get("title"),
      watermark: formData.get("watermark"),
      clips: formData.get("clips"),
      clipDuration: formData.get("clipDuration"),
      subtitleSize: formData.get("subtitleSize"),
      smartMode: formData.get("smartMode"),
      splitScreen: formData.get("splitScreen"),
      autoTitle: formData.get("autoTitle"),
    });

    const result = await processVideo({
      file: video,
      title: payload.title,
      watermark: payload.watermark,
      clipCount: payload.clips,
      clipDuration: payload.clipDuration,
      subtitleSize: payload.subtitleSize,
      smartMode: payload.smartMode,
      splitScreen: payload.splitScreen,
      autoTitle: payload.autoTitle,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Error interno procesando el video.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
