import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";

import { runFfmpeg, getMediaDurationSeconds, getMediaDimensions, extractCompressedAudio, extractKeyframes } from "@/lib/ffmpeg";
import { canTranscribe, transcribeVerbose } from "@/lib/transcription";
import { detectSceneChangeTimes, detectAdSegments, buildHeuristicMoments } from "@/lib/clip-ranking";
import type { DetectedMoment, AdSegment } from "@/lib/clip-ranking";
import { analyzeVideoVisually, buildVisualContextForPrompt } from "@/lib/visual-analysis";
import { outputDir, tempDir, jobsDir, framesDir } from "@/lib/paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LongformStyle = "compilation" | "story-arc" | "thematic";

export type LongformInput = {
  filePath: string;
  fileName: string;
  targetDurationMinutes: 5 | 7 | 10;
  format: "horizontal" | "vertical";
  style: LongformStyle;
  includeIntroOutro: boolean;
  includeChapters: boolean;
  creatorName: string;
};

export type ChapterMarker = {
  timestampSeconds: number;
  title: string;
};

export type YouTubeMetadata = {
  title: string;
  description: string;
  tags: string[];
  chapters: ChapterMarker[];
  thumbnailUrl?: string;
};

export type LongformResult = {
  jobId: string;
  fileName: string;
  url: string;
  thumbnailUrl?: string;
  durationSeconds: number;
  momentCount: number;
  youtubeMetadata: YouTubeMetadata;
  notes: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const llmClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function readFloatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

const LONGFORM_VIDEO_PRESET = process.env.LONGFORM_VIDEO_PRESET ?? "medium";
const LONGFORM_VIDEO_CRF = process.env.LONGFORM_VIDEO_CRF ?? "18";
const LONGFORM_AUDIO_BITRATE = process.env.LONGFORM_AUDIO_BITRATE ?? "192k";
const LONGFORM_CROSSFADE_DURATION = readFloatEnv("LONGFORM_CROSSFADE_DURATION", 0.5, 0.1, 2.0);
const LONGFORM_MAX_MOMENTS = readIntEnv("LONGFORM_MAX_MOMENTS", 16, 4, 30);
const LONGFORM_MIN_MOMENT_DURATION_SECONDS = readIntEnv("LONGFORM_MIN_MOMENT_DURATION_SECONDS", 20, 10, 120);
const LONGFORM_MAX_MOMENT_DURATION_SECONDS = readIntEnv("LONGFORM_MAX_MOMENT_DURATION_SECONDS", 60, 20, 180);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function secondsToYouTubeTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getMomentCount(targetDurationMinutes: number): number {
  if (targetDurationMinutes <= 5) return Math.min(LONGFORM_MAX_MOMENTS, 12);
  if (targetDurationMinutes <= 7) return Math.min(LONGFORM_MAX_MOMENTS, 14);
  return Math.min(LONGFORM_MAX_MOMENTS, 16);
}

function buildTimestampedTranscript(segments: { start: number; end: number; text: string }[]): string {
  return segments
    .map((s) => `[${formatTimecode(s.start)}-${formatTimecode(s.end)}] ${s.text}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Moment detection for long-form (watch-time optimized)
// ---------------------------------------------------------------------------

async function detectMomentsForLongform(params: {
  segments: { start: number; end: number; text: string }[];
  sceneChanges: number[];
  adSegments: AdSegment[];
  videoDuration: number;
  momentCount: number;
  style: LongformStyle;
  visualContext?: string;
  creatorName?: string;
}): Promise<DetectedMoment[] | null> {
  if (!llmClient) return null;

  const { segments, sceneChanges, adSegments, videoDuration, momentCount, style, visualContext, creatorName } = params;
  if (segments.length === 0) return null;

  const transcript = buildTimestampedTranscript(segments);
  const creator = creatorName?.trim() || "el creador";

  const adRangesStr = adSegments.length > 0
    ? `\n\nZONAS DE PUBLICIDAD (NO INCLUIR): ${adSegments.map((a) => `${formatTimecode(a.start)}-${formatTimecode(a.end)}`).join(", ")}`
    : "";

  const sceneStr = sceneChanges.length > 0
    ? `\n\nCAMBIOS DE ESCENA EN: ${sceneChanges.slice(0, 50).map((t) => formatTimecode(t)).join(", ")}`
    : "";

  const visualStr = visualContext ? `\n\n${visualContext}` : "";

  const styleInstructions: Record<LongformStyle, string> = {
    "compilation": `ESTILO: COMPILACION CRONOLOGICA. Selecciona momentos distribuidos a lo largo de todo el video y ordenalos cronologicamente (por tiempo de inicio). Prioriza variedad: mezcla momentos graciosos, emotivos, sorprendentes y de reaccion.`,
    "story-arc": `ESTILO: ARCO NARRATIVO. Selecciona momentos que juntos cuenten una historia: inicio (presentacion/contexto), desarrollo (conflicto/tension), climax (momento de mayor intensidad), desenlace (resolucion/reaccion final). Deben fluir como una historia cohesiva.`,
    "thematic": `ESTILO: TEMATICO. Agrupa momentos por tema o emocion similar (todos graciosos juntos, luego emotivos, luego sorprendentes). Reordena cronologicamente dentro de cada grupo.`,
  };

  const prompt = `Eres un editor profesional de YouTube especializado en compilaciones de alta retension.

TRANSCRIPCION CON TIMESTAMPS:
${transcript}

DURACION TOTAL: ${formatTimecode(videoDuration)}
CREADOR: ${creator}${adRangesStr}${sceneStr}${visualStr}

${styleInstructions[style]}

TU TAREA: Selecciona EXACTAMENTE ${momentCount} momentos para una compilacion de YouTube. Cada momento debe tener entre ${LONGFORM_MIN_MOMENT_DURATION_SECONDS} y ${LONGFORM_MAX_MOMENT_DURATION_SECONDS} segundos.

CRITERIOS DE SELECCION (prioridad para WATCH TIME de YouTube):
1. Momentos donde el espectador NO va a saltar — tension activa, expectativa, humor en construccion
2. Cada momento debe ser AUTOCONTENIDO: debe entenderse sin ver el resto
3. SIEMPRE incluye el setup/contexto (5-10s antes del punchline/reaccion)
4. TERMINA en punto natural: fin de reaccion, pausa dramatica o conclusion
5. Evita cortar en medio de una frase o pensamiento
6. NO incluyas zonas de publicidad
7. Mezcla duraciones: algunos momentos de 25-35s (dinamicos) y otros de 45-60s (con mas contexto)

IMPORTANTE PARA YOUTUBE:
- El primer momento es el MAS importante (determina si el espectador sigue viendo)
- Incluye al menos 2-3 momentos con humor/reaccion extrema (mayor retension)
- Evita momentos muy similares entre si (misma emocion, mismo tipo de contenido)

Responde SOLO con JSON valido (sin markdown):
{
  "moments": [
    {
      "start": <segundos como numero>,
      "end": <segundos como numero>,
      "title": "<titulo corto para chapter marker, max 50 chars>",
      "hookText": "<frase viral para el momento>",
      "zoomTimestamp": <segundo del mejor momento visual, o null>,
      "descriptions": {
        "tiktok": "<caption para TikTok>",
        "instagram": "<caption para Instagram>",
        "youtube": "<caption para YouTube>"
      },
      "scores": {
        "hook": <0-100>,
        "flow": <0-100>,
        "engagement": <0-100>,
        "completeness": <0-100>
      },
      "overallScore": <0-100>,
      "rationale": "<por que este momento tiene alta retension en YouTube>",
      "transcriptPreview": "<primeras palabras del momento>"
    }
  ]
}`;

  try {
    const response = await llmClient.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 6000,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { moments?: unknown[] };
    if (!Array.isArray(parsed.moments)) return null;

    const moments: DetectedMoment[] = parsed.moments
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
      .map((m) => ({
        start: Number(m.start ?? 0),
        end: Number(m.end ?? 0),
        title: String(m.title ?? "Momento"),
        hookText: String(m.hookText ?? ""),
        zoomTimestamp: m.zoomTimestamp != null ? Number(m.zoomTimestamp) : null,
        descriptions: {
          tiktok: String((m.descriptions as Record<string, unknown>)?.tiktok ?? ""),
          instagram: String((m.descriptions as Record<string, unknown>)?.instagram ?? ""),
          youtube: String((m.descriptions as Record<string, unknown>)?.youtube ?? ""),
        },
        scores: {
          hook: Number((m.scores as Record<string, unknown>)?.hook ?? 50),
          flow: Number((m.scores as Record<string, unknown>)?.flow ?? 50),
          engagement: Number((m.scores as Record<string, unknown>)?.engagement ?? 50),
          completeness: Number((m.scores as Record<string, unknown>)?.completeness ?? 50),
        },
        overallScore: Number(m.overallScore ?? 50),
        rationale: String(m.rationale ?? ""),
        transcriptPreview: String(m.transcriptPreview ?? ""),
      }))
      .filter((m) => m.end > m.start && m.start >= 0);

    // For compilation/thematic: sort chronologically
    if (style !== "thematic") {
      moments.sort((a, b) => a.start - b.start);
    }

    return moments.slice(0, momentCount);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FFmpeg assembly helpers
// ---------------------------------------------------------------------------

type XfadeResult = {
  filterComplex: string;
  inputArgs: string[];
  segmentOffsets: number[];
  totalDuration: number;
};

function buildXfadeFilterComplex(
  segmentPaths: string[],
  segmentDurations: number[],
  crossfadeDuration: number,
): XfadeResult {
  const n = segmentPaths.length;
  const inputArgs = segmentPaths.flatMap((p) => ["-i", p]);
  const segmentOffsets: number[] = [];

  // Compute timeline offsets (where each segment starts in the output)
  let runningOffset = 0;
  for (let i = 0; i < n; i++) {
    segmentOffsets.push(runningOffset);
    runningOffset += segmentDurations[i] - crossfadeDuration;
  }
  const totalDuration = segmentOffsets[n - 1] + segmentDurations[n - 1];

  if (n === 1) {
    return {
      filterComplex: `[0:v]copy[vout];[0:a]acopy[aout]`,
      inputArgs,
      segmentOffsets,
      totalDuration: segmentDurations[0],
    };
  }

  // Build xfade chain for video and acrossfade for audio
  const videoLines: string[] = [];
  const audioLines: string[] = [];

  for (let i = 0; i < n - 1; i++) {
    const inV = i === 0 ? `[${i}:v]` : `[vx${i - 1}]`;
    const outV = i === n - 2 ? `[vout]` : `[vx${i}]`;
    const inA = i === 0 ? `[${i}:a]` : `[ax${i - 1}]`;
    const outA = i === n - 2 ? `[aout]` : `[ax${i}]`;
    const xfadeOffset = segmentOffsets[i + 1] - crossfadeDuration;

    videoLines.push(
      `${inV}[${i + 1}:v]xfade=transition=fade:duration=${crossfadeDuration}:offset=${xfadeOffset.toFixed(3)}${outV}`
    );
    audioLines.push(`${inA}[${i + 1}:a]acrossfade=d=${crossfadeDuration}${outA}`);
  }

  const filterComplex = [...videoLines, ...audioLines].join(";");
  return { filterComplex, inputArgs, segmentOffsets, totalDuration };
}

function buildConcatFilterComplex(n: number): { filterComplex: string; inputArgs?: undefined } {
  const vInputs = Array.from({ length: n }, (_, i) => `[${i}:v]`).join("");
  const aInputs = Array.from({ length: n }, (_, i) => `[${i}:a]`).join("");
  return {
    filterComplex: `${vInputs}concat=n=${n}:v=1:a=0[vout];${aInputs}concat=n=${n}:v=0:a=1[aout]`,
  };
}

// ---------------------------------------------------------------------------
// YouTube metadata generation
// ---------------------------------------------------------------------------

async function generateYouTubeMetadata(params: {
  moments: DetectedMoment[];
  creatorName: string;
  segmentOffsets: number[];
  style: LongformStyle;
  includeChapters: boolean;
}): Promise<YouTubeMetadata> {
  const { moments, creatorName, segmentOffsets, style, includeChapters } = params;
  const creator = creatorName.trim() || "el creador";

  const momentSummary = moments
    .map((m, i) => `${i + 1}. [${formatTimecode(m.start)}] ${m.title} — ${m.rationale}`)
    .join("\n");

  const chapters: ChapterMarker[] = includeChapters
    ? [
        { timestampSeconds: 0, title: "Intro" },
        ...moments.map((m, i) => ({
          timestampSeconds: Math.floor(segmentOffsets[i] ?? 0),
          title: m.title,
        })),
      ]
    : [];

  if (!llmClient) {
    return buildFallbackMetadata(creator, moments, chapters);
  }

  const styleLabel = { compilation: "compilacion", "story-arc": "arco narrativo", thematic: "tematico" }[style];
  const chapterBlock = includeChapters
    ? chapters.map((c) => `${secondsToYouTubeTimestamp(c.timestampSeconds)} ${c.title}`).join("\n")
    : "";

  const prompt = `Genera metadata optimizada para YouTube de una ${styleLabel} de ${creator}.

MOMENTOS INCLUIDOS:
${momentSummary}

TIMESTAMPS (para chapters):
${chapterBlock || "No aplica"}

Responde SOLO con JSON valido (sin markdown):
{
  "title": "<titulo YouTube, max 70 chars, con keyword al inicio, en espanol>",
  "description": "<descripcion 3-5 parrafos: intro con keywords, highlights de momentos, CTA suscripcion, hashtags al final>",
  "tags": ["<tag1>", "<tag2>", ...]
}

REGLAS:
- Titulo: empieza con keyword principal (nombre creador o tema), usa numeros si aplica, termina con gancho emocional
- Descripcion: 150-300 palabras, incluye 3-5 palabras clave naturalmente, CTA claro al final
- Tags: 25-30 tags, mezcla nombre del creador, tipos de contenido (compilacion, mejores momentos, graciosos), temas especificos del contenido
- Todo en espanol`;

  try {
    const response = await llmClient.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.5,
      max_tokens: 1500,
    });

    const raw = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { title?: string; description?: string; tags?: string[] };

    return {
      title: String(parsed.title ?? `Mejores Momentos de ${creator}`).slice(0, 100),
      description: String(parsed.description ?? ""),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 30) : [],
      chapters,
    };
  } catch {
    return buildFallbackMetadata(creator, moments, chapters);
  }
}

function buildFallbackMetadata(
  creator: string,
  moments: DetectedMoment[],
  chapters: ChapterMarker[],
): YouTubeMetadata {
  return {
    title: `Mejores Momentos de ${creator} | Compilacion`,
    description: `Compilacion de los mejores momentos de ${creator}.\n\n${moments.map((m, i) => `${i + 1}. ${m.title}`).join("\n")}\n\n¡Suscribete para mas contenido!`,
    tags: [creator, "compilacion", "mejores momentos", "graciosos", "viral", "youtube"],
    chapters,
  };
}

// ---------------------------------------------------------------------------
// Intro/outro title card
// ---------------------------------------------------------------------------

async function buildTitleCard(params: {
  jobId: string;
  creatorName: string;
  width: number;
  height: number;
}): Promise<string> {
  const { jobId, creatorName, width, height } = params;
  const outPath = path.join(tempDir, `${jobId}_lf_intro.mp4`);
  const safeText = creatorName.replace(/'/g, "").replace(/[^\w\s-]/g, "").trim() || "Compilacion";

  await runFfmpeg([
    "-y",
    "-f", "lavfi",
    "-i", `color=c=#0f0f23:s=${width}x${height}:d=3:r=30`,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-filter_complex",
    `[0:v]drawtext=text='${safeText}':fontcolor=white:fontsize=${Math.round(height * 0.06)}:x=(w-text_w)/2:y=(h-text_h)/2:font=sans-serif[vcard]`,
    "-map", "[vcard]",
    "-map", "1:a",
    "-c:v", "libx264", "-preset", "fast", "-crf", LONGFORM_VIDEO_CRF,
    "-c:a", "aac", "-b:a", "128k",
    "-t", "3",
    "-pix_fmt", "yuv420p",
    outPath,
  ]);

  return outPath;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function compileLongformVideo(input: LongformInput): Promise<LongformResult> {
  const {
    filePath,
    fileName,
    targetDurationMinutes,
    format,
    style,
    includeIntroOutro,
    includeChapters,
    creatorName,
  } = input;

  const notes: string[] = [];

  // L-0: Setup
  const jobId = `${Date.now()}_lf_${randomUUID().slice(0, 8)}`;
  await Promise.all([
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(tempDir, { recursive: true }),
    fs.mkdir(jobsDir, { recursive: true }),
    fs.mkdir(framesDir, { recursive: true }),
  ]);

  // Determine output dimensions
  const [outWidth, outHeight] = format === "horizontal" ? [1920, 1080] : [1080, 1920];
  const videoScaleFilter = format === "horizontal"
    ? `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1`
    : `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1`;

  // Get video info
  console.log(`[longform] filePath: ${filePath}`);
  const fileStats = await fs.stat(filePath).catch((e) => { throw new Error(`Archivo no encontrado en disco: ${filePath} — ${e}`); });
  console.log(`[longform] file size on disk: ${fileStats.size} bytes`);
  if (fileStats.size === 0) throw new Error("El archivo subido esta vacio (0 bytes). Intenta subir el video de nuevo.");
  const videoDuration = await getMediaDurationSeconds(filePath);
  notes.push(`Duracion fuente: ${formatTimecode(videoDuration)}`);

  // L-1: Parallel analysis
  const audioPath = path.join(tempDir, `${jobId}_lf_audio.mp3`);
  const framesJobDir = path.join(framesDir, jobId);

  const [transcriptResult, sceneChangesResult, keyframesResult] = await Promise.allSettled([
    canTranscribe()
      ? extractCompressedAudio(filePath, audioPath).then(() =>
          transcribeVerbose(audioPath)
        )
      : Promise.reject(new Error("Sin API key")),
    detectSceneChangeTimes(filePath, videoDuration),
    extractKeyframes({ inputPath: filePath, outputDir: framesJobDir, jobId, intervalSeconds: 8, maxFrames: 50 }),
  ]);

  const transcript = transcriptResult.status === "fulfilled" ? transcriptResult.value : null;
  const sceneChanges = sceneChangesResult.status === "fulfilled" ? sceneChangesResult.value : [];
  const keyframes = keyframesResult.status === "fulfilled" ? keyframesResult.value : [];

  if (transcript) notes.push(`Transcripcion: ${transcript.segments.length} segmentos`);
  else notes.push("Sin transcripcion (no hay API key o fallo)");
  notes.push(`Cambios de escena: ${sceneChanges.length}`);

  // Visual analysis
  let visualContext: string | undefined;
  if (keyframes.length > 0 && transcript) {
    try {
      const visualResult = await analyzeVideoVisually({
        frames: keyframes,
        transcriptContext: transcript.segments.slice(0, 20).map((s) => s.text).join(" "),
        videoDuration,
      });
      if (visualResult) {
        visualContext = buildVisualContextForPrompt(visualResult);
        notes.push(`Vision AI: ${visualResult.signals.length} senales visuales`);
      }
    } catch {
      notes.push("Vision AI no disponible");
    }
  }

  const adSegments = transcript ? detectAdSegments(transcript.segments) : [];
  if (adSegments.length > 0) notes.push(`Publicidad detectada: ${adSegments.length} segmentos`);

  // L-2: Moment selection
  const momentCount = getMomentCount(targetDurationMinutes);
  let moments: DetectedMoment[] | null = null;

  if (transcript) {
    moments = await detectMomentsForLongform({
      segments: transcript.segments,
      sceneChanges,
      adSegments,
      videoDuration,
      momentCount,
      style,
      visualContext,
      creatorName,
    });
  }

  // Fallback to heuristic if LLM failed or no transcript
  if (!moments || moments.length === 0) {
    notes.push("Usando seleccion heuristica de momentos");
    moments = transcript
      ? buildHeuristicMoments({
          segments: transcript.segments,
          sceneChanges,
          adSegments,
          videoDuration,
          maxClips: momentCount,
        })
      : buildUniformMoments(videoDuration, momentCount, targetDurationMinutes);
  }

  if (moments.length === 0) {
    throw new Error("No se pudieron detectar momentos en el video.");
  }

  notes.push(`Momentos seleccionados: ${moments.length}`);

  // L-3: Extract segments in parallel
  const segmentPaths = moments.map((_, i) => path.join(tempDir, `${jobId}_lf_seg_${String(i).padStart(2, "0")}.mp4`));

  await Promise.all(
    moments.map((moment, i) =>
      runFfmpeg([
        "-y",
        "-ss", String(moment.start),
        "-t", String(moment.end - moment.start),
        "-i", filePath,
        "-vf", videoScaleFilter,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", LONGFORM_VIDEO_CRF,
        "-c:a", "aac",
        "-b:a", LONGFORM_AUDIO_BITRATE,
        "-pix_fmt", "yuv420p",
        "-avoid_negative_ts", "make_zero",
        segmentPaths[i],
      ])
    )
  );
  notes.push(`Segmentos extraidos: ${segmentPaths.length}`);

  // L-4: Intro/outro title cards
  let allSegments = [...segmentPaths];
  let introPath: string | null = null;
  let outroPath: string | null = null;

  if (includeIntroOutro) {
    try {
      introPath = await buildTitleCard({ jobId: `${jobId}_i`, creatorName, width: outWidth, height: outHeight });
      outroPath = await buildTitleCard({ jobId: `${jobId}_o`, creatorName: `${creatorName} — Suscribete`, width: outWidth, height: outHeight });
      allSegments = [introPath, ...segmentPaths, outroPath];
      notes.push("Intro y outro generados");
    } catch {
      notes.push("Intro/outro fallaron, omitidos");
    }
  }

  // Get actual durations for each segment
  const segmentDurations = await Promise.all(allSegments.map((p) => getMediaDurationSeconds(p)));

  // L-4: Assembly
  const finalOutputPath = path.join(outputDir, `${jobId}_lf_final.mp4`);
  let segmentOffsets: number[];
  let totalDuration: number;

  const useConcatFallback = allSegments.length > 12;

  if (useConcatFallback) {
    notes.push("Usando concat simple (> 12 segmentos)");
    const { filterComplex } = buildConcatFilterComplex(allSegments.length);

    await runFfmpeg([
      "-y",
      ...allSegments.flatMap((p) => ["-i", p]),
      "-filter_complex", filterComplex,
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264", "-preset", LONGFORM_VIDEO_PRESET, "-crf", LONGFORM_VIDEO_CRF,
      "-c:a", "aac", "-b:a", LONGFORM_AUDIO_BITRATE,
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      finalOutputPath,
    ]);

    // Simple offsets for concat (no crossfade overlap)
    segmentOffsets = [0];
    let acc = 0;
    for (let i = 0; i < segmentDurations.length - 1; i++) {
      acc += segmentDurations[i];
      segmentOffsets.push(acc);
    }
    totalDuration = segmentDurations.reduce((a, b) => a + b, 0);
  } else {
    const xfade = buildXfadeFilterComplex(allSegments, segmentDurations, LONGFORM_CROSSFADE_DURATION);

    await runFfmpeg([
      "-y",
      ...xfade.inputArgs,
      "-filter_complex", xfade.filterComplex,
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264", "-preset", LONGFORM_VIDEO_PRESET, "-crf", LONGFORM_VIDEO_CRF,
      "-c:a", "aac", "-b:a", LONGFORM_AUDIO_BITRATE,
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      finalOutputPath,
    ]);

    segmentOffsets = xfade.segmentOffsets;
    totalDuration = xfade.totalDuration;
  }

  notes.push(`Video ensamblado: ${formatTimecode(totalDuration)}`);

  // Adjust offsets to skip intro if present
  const momentOffsets = includeIntroOutro && introPath
    ? segmentOffsets.slice(1, 1 + moments.length)
    : segmentOffsets.slice(0, moments.length);

  // L-6: Thumbnail extraction
  let thumbnailUrl: string | undefined;
  try {
    const thumbPath = path.join(outputDir, `${jobId}_lf_thumb.jpg`);
    const thumbTimestamp = momentOffsets[0] != null ? momentOffsets[0] + 2 : 2;
    await runFfmpeg([
      "-y",
      "-ss", String(thumbTimestamp),
      "-i", finalOutputPath,
      "-frames:v", "1",
      "-q:v", "2",
      thumbPath,
    ]);
    thumbnailUrl = `/api/download/${jobId}_lf_thumb.jpg`;
    notes.push("Thumbnail generado");
  } catch {
    notes.push("Thumbnail fallido, omitido");
  }

  // L-7: YouTube metadata
  const youtubeMetadata = await generateYouTubeMetadata({
    moments,
    creatorName,
    segmentOffsets: momentOffsets,
    style,
    includeChapters,
  });

  // L-8: Save manifest
  const manifest = {
    jobId,
    type: "longform" as const,
    sourceVideoPath: filePath,
    outputVideoPath: finalOutputPath,
    fileName: `${jobId}_lf_final.mp4`,
    format,
    style,
    creatorName,
    targetDurationMinutes,
    momentCount: moments.length,
    durationSeconds: totalDuration,
    youtubeMetadata,
    createdAt: new Date().toISOString(),
    notes,
  };

  await fs.writeFile(
    path.join(jobsDir, `${jobId}_longform.json`),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  // Cleanup temp segments
  await Promise.allSettled([
    ...segmentPaths.map((p) => fs.unlink(p)),
    introPath ? fs.unlink(introPath) : Promise.resolve(),
    outroPath ? fs.unlink(outroPath) : Promise.resolve(),
    fs.unlink(audioPath).catch(() => {}),
  ]);

  return {
    jobId,
    fileName: `${jobId}_lf_final.mp4`,
    url: `/api/download/${jobId}_lf_final.mp4`,
    thumbnailUrl,
    durationSeconds: totalDuration,
    momentCount: moments.length,
    youtubeMetadata,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Uniform fallback (no transcript, no heuristic data)
// ---------------------------------------------------------------------------

function buildUniformMoments(
  videoDuration: number,
  count: number,
  targetDurationMinutes: number,
): DetectedMoment[] {
  const targetPerMoment = Math.floor((targetDurationMinutes * 60) / count);
  const duration = Math.max(
    LONGFORM_MIN_MOMENT_DURATION_SECONDS,
    Math.min(LONGFORM_MAX_MOMENT_DURATION_SECONDS, targetPerMoment),
  );
  const step = videoDuration / count;

  return Array.from({ length: count }, (_, i) => {
    const start = Math.round(i * step);
    const end = Math.min(start + duration, videoDuration);
    return {
      start,
      end,
      title: `Momento ${i + 1}`,
      hookText: "",
      zoomTimestamp: null,
      descriptions: { tiktok: "", instagram: "", youtube: "" },
      scores: { hook: 50, flow: 50, engagement: 50, completeness: 50 },
      overallScore: 50,
      rationale: "Seleccion uniforme (sin transcripcion)",
      transcriptPreview: "",
    };
  });
}
