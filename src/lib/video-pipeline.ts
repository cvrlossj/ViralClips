import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildCandidateWindows,
  detectSceneChangeTimes,
  pickHeuristicWindows,
  rerankWithLlm,
} from "@/lib/clip-ranking";
import {
  ensurePathForSubtitlesFilter,
  ensureTextForDrawText,
  getMediaDurationSeconds,
  runFfmpeg,
} from "@/lib/ffmpeg";
import { outputDir, tempDir, uploadDir } from "@/lib/paths";
import {
  canTranscribe,
  transcribeToSrt,
  transcribeVerbose,
} from "@/lib/transcription";

type PipelineInput = {
  file: File;
  title: string;
  watermark: string;
  clipCount: number;
  clipDuration: number;
  smartMode: boolean;
};

type ClipResult = {
  fileName: string;
  url: string;
  startSeconds: number;
  durationSeconds: number;
  hasSubtitles: boolean;
  score: number;
  rationale: string;
};

type PipelineResult = {
  jobId: string;
  clips: ClipResult[];
  notes: string[];
};

type ScoreInfo = {
  score: number;
  rationale: string;
};

const clipVideoPreset = process.env.CLIP_VIDEO_PRESET ?? "medium";
const clipVideoCrf = process.env.CLIP_VIDEO_CRF ?? "18";
const clipAudioBitrate = process.env.CLIP_AUDIO_BITRATE ?? "192k";

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9-_]/g, "_");
}

async function ensureStorageFolders() {
  await Promise.all([
    fs.mkdir(uploadDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(tempDir, { recursive: true }),
  ]);
}

function buildStarts(duration: number, count: number, clipDuration: number) {
  const maxStart = Math.max(duration - clipDuration, 0);

  if (count === 1) {
    return [0];
  }

  const step = maxStart / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.max(0, step * i));
}

function outputFileName(jobId: string, index: number) {
  return `${jobId}_clip_${String(index + 1).padStart(2, "0")}.mp4`;
}

export async function processVideo(input: PipelineInput): Promise<PipelineResult> {
  const jobId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  await ensureStorageFolders();

  const extension =
    path.extname(input.file.name).toLowerCase().replace(/[^a-z0-9.]/g, "") ||
    ".mp4";
  const uploadFilePath = path.join(uploadDir, `${jobId}${extension}`);
  const data = Buffer.from(await input.file.arrayBuffer());
  await fs.writeFile(uploadFilePath, data);

  const duration = await getMediaDurationSeconds(uploadFilePath);
  let starts = buildStarts(duration, input.clipCount, input.clipDuration);
  let scoreMap = new Map<number, ScoreInfo>();
  const clipResults: ClipResult[] = [];

  const safeTitle = ensureTextForDrawText(input.title.trim() || "Clip viral");
  const safeWatermark = ensureTextForDrawText(
    input.watermark.trim() || "@viralclips",
  );

  let transcriptSegmentsCount = 0;
  let sceneChanges: number[] = [];
  let usedLlmRerank = false;

  if (input.smartMode) {
    try {
      const transcriptSegments = canTranscribe()
        ? (await transcribeVerbose(uploadFilePath)).segments
        : [];
      transcriptSegmentsCount = transcriptSegments.length;
      sceneChanges = await detectSceneChangeTimes(uploadFilePath);

      if (transcriptSegments.length > 0 || sceneChanges.length > 0) {
        const candidates = buildCandidateWindows({
          duration,
          clipDuration: input.clipDuration,
          segments: transcriptSegments,
          sceneChanges,
        });

        const heuristic = pickHeuristicWindows({
          candidates,
          clipCount: input.clipCount,
          clipDuration: input.clipDuration,
        });

        let selected = heuristic;
        const reranked = await rerankWithLlm({
          candidates,
          clipCount: input.clipCount,
          clipDuration: input.clipDuration,
        });

        if (reranked && reranked.length > 0) {
          selected = reranked;
          usedLlmRerank = true;
        }

        if (selected.length > 0) {
          starts = selected.map((item) => item.start).sort((a, b) => a - b);
          scoreMap = new Map<number, ScoreInfo>();
          selected.forEach((item) => {
            scoreMap.set(Number(item.start.toFixed(2)), {
              score: item.score,
              rationale: item.rationale,
            });
          });
        }
      }
    } catch {
      starts = buildStarts(duration, input.clipCount, input.clipDuration);
      scoreMap = new Map<number, ScoreInfo>();
    }
  }

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const durationForClip = Math.min(input.clipDuration, Math.max(duration - start, 1));

    const subtitlePath = path.join(tempDir, `${jobId}_clip_${i + 1}.srt`);
    let hasSubtitles = false;

    if (canTranscribe()) {
      try {
        const tempAudioPath = path.join(tempDir, `${jobId}_clip_${i + 1}.wav`);

        await runFfmpeg([
          "-y",
          "-ss",
          start.toFixed(2),
          "-t",
          durationForClip.toFixed(2),
          "-i",
          uploadFilePath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          tempAudioPath,
        ]);

        const srt = await transcribeToSrt(tempAudioPath);
        await fs.writeFile(subtitlePath, srt, "utf-8");
        await fs.rm(tempAudioPath, { force: true });
        hasSubtitles = true;
      } catch {
        hasSubtitles = false;
      }
    }

    const filters: string[] = [];
    if (hasSubtitles) {
      const safeSubPath = ensurePathForSubtitlesFilter(subtitlePath);
      filters.push(
        `subtitles='${safeSubPath}':force_style='FontName=Arial,FontSize=19,Outline=2,MarginV=76'`,
      );
    }
    filters.push(
      `drawtext=text='${safeTitle}':font=Arial:fontcolor=white:fontsize=56:box=1:boxcolor=black@0.55:boxborderw=22:x=(w-text_w)/2:y=72`,
    );
    filters.push(
      `drawtext=text='${safeWatermark}':font=Arial:fontcolor=white:fontsize=36:box=1:boxcolor=black@0.5:boxborderw=14:x=(w-text_w)/2:y=h-th-54`,
    );

    const fileName = outputFileName(jobId, i);
    const finalPath = path.join(outputDir, fileName);

    await runFfmpeg([
      "-y",
      "-ss",
      start.toFixed(2),
      "-t",
      durationForClip.toFixed(2),
      "-i",
      uploadFilePath,
      "-vf",
      `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${filters.join(",")}`,
      "-c:v",
      "libx264",
      "-preset",
      clipVideoPreset,
      "-crf",
      clipVideoCrf,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      clipAudioBitrate,
      "-movflags",
      "+faststart",
      finalPath,
    ]);

    if (hasSubtitles) {
      await fs.rm(subtitlePath, { force: true });
    }

    clipResults.push({
      fileName,
      url: `/api/download/${encodeURIComponent(fileName)}`,
      startSeconds: start,
      durationSeconds: durationForClip,
      hasSubtitles,
      score: Number(
        (scoreMap.get(Number(start.toFixed(2)))?.score ?? 0).toFixed(2),
      ),
      rationale:
        scoreMap.get(Number(start.toFixed(2)))?.rationale ?? "corte uniforme",
    });
  }

  await fs.rm(uploadFilePath, { force: true });

  return {
    jobId: sanitizeName(jobId),
    clips: clipResults,
    notes: [
      canTranscribe()
        ? "Subtitulos activados con OpenAI."
        : "Sin OPENAI_API_KEY: se generaron clips con titulo y marca de agua.",
      input.smartMode && transcriptSegmentsCount > 0
        ? "Modo inteligente activo: score narrativo + deteccion de cambios de escena."
        : "Modo inteligente no disponible: seleccion por distribucion temporal.",
      usedLlmRerank
        ? "Re-ranking final con LLM aplicado en la seleccion de clips."
        : "Re-ranking LLM no aplicado; se uso seleccion heuristica.",
      `Perfil de render: preset=${clipVideoPreset} crf=${clipVideoCrf} audio=${clipAudioBitrate}.`,
      sceneChanges.length > 0
        ? `Cambios de escena detectados: ${sceneChanges.length}.`
        : "Sin cambios de escena detectados o no disponibles.",
      "Salida en formato vertical 1080x1920.",
    ],
  };
}
