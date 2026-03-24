import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jobsDir, outputDir, storageRoot, tempDir } from "@/lib/paths";
import { renderSingleClip, type JobManifest } from "@/lib/video-pipeline";
import { getMediaDimensions } from "@/lib/ffmpeg";
import { canTranscribe } from "@/lib/transcription";
import { getPreset, wordsToPresetAss, DEFAULT_PRESET_ID } from "@/lib/caption-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const rerenderSchema = z.object({
  jobId: z.string().min(1),
  clipIndex: z.number().int().min(0),
  title: z.string().max(80).optional(),
  start: z.number().min(0).optional(),
  duration: z.number().min(1).max(90).optional(),
  watermark: z.string().max(50).optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const params = rerenderSchema.parse(body);

    const manifestPath = path.join(jobsDir, `${params.jobId}.json`);
    const manifestData = await fs.readFile(manifestPath, "utf-8");
    const manifest: JobManifest = JSON.parse(manifestData);

    if (params.clipIndex >= manifest.clips.length) {
      return NextResponse.json({ error: "Clip index fuera de rango." }, { status: 400 });
    }

    const clip = manifest.clips[params.clipIndex];
    const newStart = params.start ?? clip.startSeconds;
    const newDuration = params.duration ?? clip.durationSeconds;
    const newTitle = params.title ?? clip.title;
    const newWatermark = params.watermark ?? manifest.settings.watermark;

    // Check source video exists
    try {
      await fs.access(manifest.sourceVideoPath);
    } catch {
      return NextResponse.json(
        { error: "Video fuente no encontrado. Puede haber sido eliminado." },
        { status: 404 },
      );
    }

    // Get dimensions for split-screen
    let srcWidth = 0;
    let srcHeight = 0;
    if (manifest.settings.splitScreen) {
      try {
        const dims = await getMediaDimensions(manifest.sourceVideoPath);
        srcWidth = dims.width;
        srcHeight = dims.height;
      } catch { /* ignore */ }
    }

    // Generate subtitles using the job's caption preset
    let subtitlePath: string | null = null;
    if (canTranscribe() && manifest.words.length > 0) {
      const clipWords = manifest.words
        .filter((w) => w.start >= newStart && w.end <= newStart + newDuration)
        .map((w) => ({ word: w.word, start: w.start - newStart, end: w.end - newStart }));

      if (clipWords.length > 0) {
        const preset = getPreset(manifest.settings.captionPreset ?? DEFAULT_PRESET_ID);
        const ass = wordsToPresetAss(clipWords, manifest.settings.subtitleSize, preset);
        subtitlePath = path.join(tempDir, `rerender_${params.jobId}_${params.clipIndex}.ass`);
        await fs.writeFile(subtitlePath, ass, "utf-8");
      }
    }

    // Resolve watermark image path
    let watermarkPath: string | null = null;
    const wmImage = (manifest.settings as Record<string, unknown>).watermarkImage as string | undefined;
    if (wmImage && wmImage !== "none") {
      const wmFullPath = path.join(storageRoot, "watermark", path.basename(wmImage));
      try {
        await fs.access(wmFullPath);
        watermarkPath = wmFullPath;
      } catch { /* watermark file missing, skip */ }
    }

    // Re-render the clip
    const outputPath = path.join(outputDir, clip.fileName);
    await renderSingleClip({
      sourceVideoPath: manifest.sourceVideoPath,
      outputPath,
      start: newStart,
      duration: newDuration,
      title: newTitle,
      watermark: newWatermark,
      subtitlePath,
      splitScreen: manifest.settings.splitScreen,
      srcWidth,
      srcHeight,
      hookText: clip.hookText || undefined,
      watermarkPath,
    });

    // Clean up temp subtitle file
    if (subtitlePath) {
      await fs.rm(subtitlePath, { force: true });
    }

    // Update manifest with new clip data
    manifest.clips[params.clipIndex] = {
      ...clip,
      startSeconds: newStart,
      durationSeconds: newDuration,
      title: newTitle,
      hasSubtitles: subtitlePath !== null,
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    return NextResponse.json({
      success: true,
      clip: manifest.clips[params.clipIndex],
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Error re-renderizando el clip.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
