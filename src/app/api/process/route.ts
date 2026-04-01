import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertFfmpegInstalled } from "@/lib/ffmpeg";
import { processVideo } from "@/lib/video-pipeline";
import { tempDir } from "@/lib/paths";
import { parseMultipart } from "@/lib/multipart";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const booleanPreprocess = z.preprocess((value) => {
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value;
}, z.boolean());

const formSchema = z.object({
  clips: z.coerce.number().int().min(1).max(20).default(8),
  splitScreen: booleanPreprocess.default(false),
  hookOptimizer: booleanPreprocess.default(true),
  watermarkImage: z.string().trim().max(100).default("none"),
});

export async function POST(request: Request) {
  try {
    await Promise.all([
      assertFfmpegInstalled(),
      fs.mkdir(tempDir, { recursive: true }),
    ]);

    const { filePath, fileName, fields } = await parseMultipart(request);

    const payload = formSchema.parse({
      clips: fields.clips,
      splitScreen: fields.splitScreen,
      hookOptimizer: fields.hookOptimizer,
      watermarkImage: fields.watermarkImage,
    });

    const result = await processVideo({
      filePath,
      fileName,
      clipCount: payload.clips,
      splitScreen: payload.splitScreen,
      hookOptimizer: payload.hookOptimizer,
      watermarkImage: payload.watermarkImage,
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
