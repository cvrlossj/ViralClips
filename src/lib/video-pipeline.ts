import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildHeuristicMoments,
  detectAdSegments,
  detectMomentsWithLlm,
  detectSceneChangeTimes,
  type ClipScores,
  type DetectedMoment,
  type PlatformDescriptions,
} from "@/lib/clip-ranking";
import {
  ensurePathForSubtitlesFilter,
  ensureTextForDrawText,
  extractCompressedAudio,
  extractKeyframes,
  getMediaDimensions,
  getMediaDurationSeconds,
  runFfmpeg,
} from "@/lib/ffmpeg";
import { benchmarksDir, framesDir, jobsDir, outputDir, sourcesDir, storageRoot, tempDir, uploadDir } from "@/lib/paths";
import {
  analyzeVideoVisually,
  buildVisualContextForPrompt,
  type VisualAnalysisResult,
} from "@/lib/visual-analysis";
import {
  getPreset,
  wordsToPresetAss,
  srtToPresetAss,
  DEFAULT_PRESET_ID,
  type CaptionPreset,
} from "@/lib/caption-presets";
import {
  buildBenchmarkPromptContext,
  type ViralBenchmark,
} from "@/lib/tiktok-analytics";
import OpenAI from "openai";
import {
  canTranscribe,
  transcribeToSrt,
  transcribeVerbose,
  transcribeWords,
  type TranscriptWord,
} from "@/lib/transcription";

const titleClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

type PipelineInput = {
  /** Path to the video file already saved on disk */
  filePath: string;
  /** Original file name (for extension detection) */
  fileName: string;
  title: string;
  watermark: string;
  clipCount: number;
  subtitleSize: number;
  splitScreen: boolean;
  autoTitle: boolean;
  /** Caption preset ID (e.g. "hormozi", "mrbeast") */
  captionPreset: string;
  /** Enable hook optimizer (spoiler hook at start) */
  hookOptimizer: boolean;
  /** Watermark image filename from storage/watermark/ (e.g. "marca_de_agua.png") or "none" */
  watermarkImage: string;
};

export type ClipResult = {
  fileName: string;
  url: string;
  startSeconds: number;
  durationSeconds: number;
  hasSubtitles: boolean;
  scores: ClipScores;
  overallScore: number;
  rationale: string;
  title: string;
  /** Short hook text overlay (2-5 words) */
  hookText: string;
  /** Platform-specific descriptions/captions */
  descriptions: { tiktok: string; instagram: string; youtube: string };
  thumbnailUrl?: string;
  hookApplied?: boolean;
};

type PipelineResult = {
  jobId: string;
  clips: ClipResult[];
  notes: string[];
};

export type JobManifest = {
  jobId: string;
  sourceVideoPath: string;
  sourceFileName: string;
  clips: ClipResult[];
  words: TranscriptWord[];
  visualAnalysis?: {
    summary: string;
    hotSpots: { start: number; end: number; reason: string }[];
    signalCount: number;
  };
  settings: {
    watermark: string;
    subtitleSize: number;
    splitScreen: boolean;
    captionPreset: string;
    hookOptimizer: boolean;
    watermarkImage: string;
  };
  notes: string[];
  createdAt: string;
};

const clipVideoPreset = process.env.CLIP_VIDEO_PRESET ?? "medium";
const clipVideoCrf = process.env.CLIP_VIDEO_CRF ?? "18";
const clipAudioBitrate = process.env.CLIP_AUDIO_BITRATE ?? "192k";

async function loadActiveBenchmarkContext(): Promise<string> {
  try {
    const raw = await fs.readFile(
      path.join(benchmarksDir, "active-benchmark.json"),
      "utf-8",
    );
    const data = JSON.parse(raw) as { benchmark?: ViralBenchmark };
    if (data.benchmark && data.benchmark.totalAnalyzed > 0) {
      return buildBenchmarkPromptContext(data.benchmark);
    }
  } catch {
    // No benchmark saved — that's fine
  }
  return "";
}

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9-_]/g, "_");
}

async function ensureStorageFolders() {
  await Promise.all([
    fs.mkdir(uploadDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(tempDir, { recursive: true }),
    fs.mkdir(sourcesDir, { recursive: true }),
    fs.mkdir(jobsDir, { recursive: true }),
    fs.mkdir(framesDir, { recursive: true }),
  ]);
}

function buildStarts(duration: number, count: number, clipDuration: number) {
  const maxStart = Math.max(duration - clipDuration, 0);
  if (count === 1) return [0];
  const step = maxStart / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.max(0, step * i));
}

function outputFileName(jobId: string, index: number) {
  return `${jobId}_clip_${String(index + 1).padStart(2, "0")}.mp4`;
}

// ---------------------------------------------------------------------------
// Sentence-boundary snapping
// ---------------------------------------------------------------------------
// Shifts a clip start/end by up to ±maxShift seconds so it begins/ends at a
// natural sentence boundary (punctuation or speech gap > gapThreshold).
// ---------------------------------------------------------------------------

const SENTENCE_END_RE = /[.!?;…]\s*$/;
const GAP_THRESHOLD_MS = 300;
const MAX_SHIFT_S = 2;

function snapToSentenceBoundary(
  words: TranscriptWord[],
  rawStart: number,
  rawEnd: number,
): { start: number; end: number } {
  if (words.length === 0) return { start: rawStart, end: rawEnd };

  // Find best start: look for a word whose start is near rawStart and follows
  // a sentence-ending word or a speech gap.
  let bestStart = rawStart;
  let bestStartDist = Infinity;

  for (let i = 0; i < words.length; i++) {
    const dist = Math.abs(words[i].start - rawStart);
    if (dist > MAX_SHIFT_S) continue;

    // First word is always a valid start
    if (i === 0) {
      if (dist < bestStartDist) {
        bestStart = words[i].start;
        bestStartDist = dist;
      }
      continue;
    }

    const prev = words[i - 1];
    const gap = (words[i].start - prev.end) * 1000;
    const prevEndsSentence = SENTENCE_END_RE.test(prev.word);

    if (prevEndsSentence || gap >= GAP_THRESHOLD_MS) {
      if (dist < bestStartDist) {
        bestStart = words[i].start;
        bestStartDist = dist;
      }
    }
  }

  // Find best end: look for a word whose end is near rawEnd and ends a sentence
  // or is followed by a speech gap.
  let bestEnd = rawEnd;
  let bestEndDist = Infinity;

  for (let i = 0; i < words.length; i++) {
    const dist = Math.abs(words[i].end - rawEnd);
    if (dist > MAX_SHIFT_S) continue;

    const endsSentence = SENTENCE_END_RE.test(words[i].word);
    const nextGap =
      i < words.length - 1
        ? (words[i + 1].start - words[i].end) * 1000
        : Infinity;

    if (endsSentence || nextGap >= GAP_THRESHOLD_MS || i === words.length - 1) {
      if (dist < bestEndDist) {
        bestEnd = words[i].end;
        bestEndDist = dist;
      }
    }
  }

  return { start: bestStart, end: bestEnd };
}

// ---------------------------------------------------------------------------
// ASS subtitle generation — now uses caption presets from caption-presets.ts
// The old hardcoded ASS functions have been replaced by the preset system.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auto-generated viral titles per clip
// ---------------------------------------------------------------------------
// Uses GPT-4o-mini to generate a short, engaging, click-worthy title based on
// the transcript of each clip segment.
// ---------------------------------------------------------------------------

function extractClipTranscript(
  words: TranscriptWord[],
  start: number,
  end: number,
): string {
  return words
    .filter((w) => w.start >= start && w.end <= end)
    .map((w) => w.word)
    .join(" ")
    .trim();
}

async function generateViralTitle(transcript: string): Promise<string> {
  if (!titleClient || !transcript.trim()) return "";

  try {
    const response = await titleClient.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.8,
      max_tokens: 60,
      messages: [
        {
          role: "system",
          content: [
            "Eres un experto en contenido viral para YouTube Shorts, TikTok e Instagram Reels.",
            "Tu trabajo es crear titulos CORTOS (maximo 6-8 palabras) que:",
            "- Generen curiosidad inmediata",
            "- Hagan que el usuario NO pueda pasar el video",
            "- Usen lenguaje directo y emocional",
            "- NO usen emojis",
            "- NO usen hashtags",
            "- NO usen comillas",
            "Responde SOLO con el titulo, nada mas.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Genera un titulo viral para este clip. Transcripcion:\n\n${transcript.slice(0, 500)}`,
        },
      ],
    });

    return (response.choices[0]?.message?.content ?? "").trim().slice(0, 80);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Clip audio transcription (runs in parallel across clips)
// ---------------------------------------------------------------------------
// Returns word-level timestamps when available (for karaoke), falls back to
// SRT-based ASS when the API doesn't return words.
// ---------------------------------------------------------------------------

async function transcribeClipAudio(params: {
  uploadFilePath: string;
  jobId: string;
  index: number;
  start: number;
  durationForClip: number;
  subtitleFontSize: number;
  captionPreset: CaptionPreset;
}): Promise<{ hasSubtitles: boolean; subtitlePath: string; isKaraoke: boolean }> {
  const { uploadFilePath, jobId, index, start, durationForClip, subtitleFontSize, captionPreset } = params;
  const subtitlePath = path.join(tempDir, `${jobId}_clip_${index + 1}.ass`);

  if (!canTranscribe()) return { hasSubtitles: false, subtitlePath, isKaraoke: false };

  try {
    const tempAudioPath = path.join(tempDir, `${jobId}_clip_${index + 1}.wav`);

    await runFfmpeg([
      "-y",
      "-ss", start.toFixed(2),
      "-t", durationForClip.toFixed(2),
      "-i", uploadFilePath,
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "pcm_s16le",
      tempAudioPath,
    ]);

    // Try word-level transcription first (karaoke with preset)
    try {
      const words = await transcribeWords(tempAudioPath);
      if (words.length > 0) {
        const ass = wordsToPresetAss(words, subtitleFontSize, captionPreset);
        await fs.writeFile(subtitlePath, ass, "utf-8");
        await fs.rm(tempAudioPath, { force: true });
        return { hasSubtitles: true, subtitlePath, isKaraoke: true };
      }
    } catch {
      // Word-level failed, fall back to SRT-based
    }

    // Fallback: SRT-based subtitles with preset
    const srt = await transcribeToSrt(tempAudioPath);
    const ass = srtToPresetAss(srt, subtitleFontSize, captionPreset);
    await fs.writeFile(subtitlePath, ass, "utf-8");
    await fs.rm(tempAudioPath, { force: true });

    return { hasSubtitles: true, subtitlePath, isKaraoke: false };
  } catch {
    return { hasSubtitles: false, subtitlePath, isKaraoke: false };
  }
}

// ---------------------------------------------------------------------------
// Single clip renderer — used by both the main pipeline and re-render API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Anti-copyright: watermark PNG
// ---------------------------------------------------------------------------
const WATERMARK_DIR = path.join(storageRoot, "watermark");

async function resolveWatermarkPath(fileName?: string): Promise<string | null> {
  if (!fileName || fileName === "none") return null;
  const safeName = path.basename(fileName);
  const fullPath = path.join(WATERMARK_DIR, safeName);
  try {
    await fs.access(fullPath);
    return fullPath;
  } catch {
    return null;
  }
}

export async function renderSingleClip(params: {
  sourceVideoPath: string;
  outputPath: string;
  start: number;
  duration: number;
  title: string;
  watermark: string;
  subtitlePath: string | null;
  splitScreen: boolean;
  srcWidth: number;
  srcHeight: number;
  /** Hook text overlay (shown first 3s) */
  hookText?: string;
  /** Zoom timestamp relative to clip start (seconds) */
  zoomAt?: number;
  /** Absolute path to watermark PNG (or null to skip) */
  watermarkPath?: string | null;
}): Promise<void> {
  const { sourceVideoPath, outputPath, start, duration, subtitlePath, splitScreen } = params;

  // ---------------------------------------------------------------------------
  // Full 9:16 (1080x1920) — NO black bars. Video fills the entire frame.
  // ---------------------------------------------------------------------------
  // Anti-copyright protections applied:
  // 1. Pitch shift +2% on audio (breaks audio fingerprint)
  // 2. Subtle color shift (saturation +0.08, brightness +0.02)
  // 3. Watermark PNG overlay (marca_de_agua.png)
  // ---------------------------------------------------------------------------

  const OUT_W = 1080;
  const OUT_H = 1920;

  const isLandscape = params.srcWidth > params.srcHeight && params.srcWidth > 0;
  const applySplit = splitScreen && isLandscape;

  // Watermark image overlay
  const watermarkPath = params.watermarkPath ?? null;
  const hasWatermark = !!watermarkPath;

  // Hook text overlay: big text shown in first 3 seconds
  const hookTextFilter = params.hookText
    ? `drawtext=text='${ensureTextForDrawText(params.hookText)}':font='Arial Black':fontcolor=yellow:fontsize=64:borderw=5:bordercolor=black:x=(w-text_w)/2:y=h*0.35:enable='between(t,0.2,3.0)'`
    : "";

  // Dynamic zoom at peak moment
  const zoomFilter = params.zoomAt != null && params.zoomAt > 0
    ? (() => {
        const zoomStart = Math.max(0, params.zoomAt - 0.8);
        const zoomEnd = params.zoomAt + 1.5;
        return `zoompan=z='if(between(in_time,${zoomStart.toFixed(2)},${zoomEnd.toFixed(2)}),1.0+0.12*sin((in_time-${zoomStart.toFixed(2)})/${(zoomEnd - zoomStart).toFixed(2)}*PI),1.0)':d=1:s=${OUT_W}x${OUT_H}:fps=30`;
      })()
    : "";

  // Anti-copyright: subtle color shift (slightly warmer + more saturated)
  const colorShiftFilter = "eq=saturation=1.08:brightness=0.02";

  // Anti-copyright: pitch shift +2% (imperceptible but breaks Content ID)
  // asetrate changes sample rate interpretation → pitch up, then aresample restores correct rate
  const audioFilter = "asetrate=44100*1.02,aresample=44100";

  // Build overlay filters (subtitles + hook text + color shift)
  function buildOverlayFilters(): string[] {
    const f: string[] = [];
    f.push(colorShiftFilter);
    if (subtitlePath) {
      f.push(`subtitles='${ensurePathForSubtitlesFilter(subtitlePath)}'`);
    }
    if (hookTextFilter) f.push(hookTextFilter);
    return f;
  }

  if (applySplit) {
    const halfH = Math.floor(OUT_H / 2);
    const overlayFilters = buildOverlayFilters();
    overlayFilters.push(
      `drawbox=x=0:y=${halfH - 2}:w=iw:h=4:color=white@0.4:t=fill`,
    );

    const overlayChain = overlayFilters.length > 0 ? `,${overlayFilters.join(",")}` : "";

    // Build inputs
    const inputs = [
      "-y", "-ss", start.toFixed(2), "-t", duration.toFixed(2),
      "-i", sourceVideoPath,
    ];

    let filterComplex: string;
    if (hasWatermark) {
      inputs.push("-i", watermarkPath!);
      filterComplex = [
        `[0:v]split[a][b]`,
        `[a]crop=iw/2:ih:0:0,scale=${OUT_W}:${halfH}[left]`,
        `[b]crop=iw/2:ih:iw/2:0,scale=${OUT_W}:${halfH}[right]`,
        `[left][right]vstack${overlayChain}[stacked]`,
        `[1:v]scale=160:-1,format=rgba,colorchannelmixer=aa=0.7[wm]`,
        `[stacked][wm]overlay=W-w-30:H-h-30[out]`,
      ].join(";");
    } else {
      filterComplex = [
        `[0:v]split[a][b]`,
        `[a]crop=iw/2:ih:0:0,scale=${OUT_W}:${halfH}[left]`,
        `[b]crop=iw/2:ih:iw/2:0,scale=${OUT_W}:${halfH}[right]`,
        `[left][right]vstack${overlayChain}[out]`,
      ].join(";");
    }

    await runFfmpeg([
      ...inputs,
      "-filter_complex", filterComplex,
      "-af", audioFilter,
      "-map", "[out]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", clipVideoPreset, "-crf", clipVideoCrf,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", clipAudioBitrate,
      "-movflags", "+faststart",
      outputPath,
    ]);
  } else {
    const filters = buildOverlayFilters();

    // Scale to fill 1080x1920 (9:16) — crop to avoid black bars
    const scaleChain = zoomFilter
      ? `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},${zoomFilter}`
      : `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H}`;

    const inputs = [
      "-y", "-ss", start.toFixed(2), "-t", duration.toFixed(2),
      "-i", sourceVideoPath,
    ];

    if (hasWatermark) {
      // Use filter_complex for watermark overlay
      inputs.push("-i", watermarkPath!);

      const videoChain = `[0:v]${scaleChain}${filters.length > 0 ? `,${filters.join(",")}` : ""}[base]`;
      const wmChain = `[1:v]scale=160:-1,format=rgba,colorchannelmixer=aa=0.7[wm]`;
      const overlayChain = `[base][wm]overlay=W-w-30:H-h-30[out]`;
      const filterComplex = [videoChain, wmChain, overlayChain].join(";");

      await runFfmpeg([
        ...inputs,
        "-filter_complex", filterComplex,
        "-af", audioFilter,
        "-map", "[out]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", clipVideoPreset, "-crf", clipVideoCrf,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", clipAudioBitrate,
        "-movflags", "+faststart",
        outputPath,
      ]);
    } else {
      // No watermark — simple -vf chain
      let vf = scaleChain;
      if (filters.length > 0) {
        vf += `,${filters.join(",")}`;
      }

      await runFfmpeg([
        ...inputs,
        "-vf", vf,
        "-af", audioFilter,
        "-c:v", "libx264", "-preset", clipVideoPreset, "-crf", clipVideoCrf,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", clipAudioBitrate,
        "-movflags", "+faststart",
        outputPath,
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// Hook Optimizer — "Spoiler Hook" technique
// ---------------------------------------------------------------------------
// MrBeast/Hormozi technique: show the most impactful 2-3 seconds FIRST,
// then flash "moments before..." text, then play the full clip from start.
// This grabs attention immediately and makes viewers stay to see the context.
// ---------------------------------------------------------------------------

async function applyHookOptimizer(params: {
  clipPath: string;
  sourceVideoPath: string;
  clipStart: number;
  clipDuration: number;
  visualSignals: { timestamp: number; viralPotential: number; energy: string }[];
  words: TranscriptWord[];
  jobId: string;
  clipIndex: number;
}): Promise<boolean> {
  const { clipPath, clipStart, clipDuration, visualSignals, words, jobId, clipIndex } = params;

  // Find the "peak moment" — highest visual energy within the clip range
  const clipEnd = clipStart + clipDuration;
  const clipSignals = visualSignals.filter(
    (s) => s.timestamp >= clipStart && s.timestamp <= clipEnd,
  );

  // Use visual signals if available, otherwise find an exclamation/hook word
  let peakTimeInClip = clipDuration * 0.6; // default: 60% into clip

  if (clipSignals.length > 0) {
    const peak = clipSignals.reduce((best, s) =>
      s.viralPotential > best.viralPotential ? s : best,
    );
    peakTimeInClip = peak.timestamp - clipStart;
  } else if (words.length > 0) {
    // Find exclamation/reaction words in the clip
    const hookPatterns = /(!|jaja|wow|no\s+puede|increible|mira|que\s+paso|loco|brutal|wait|what|oh\s+my)/i;
    const clipWords = words.filter((w) => w.start >= clipStart && w.end <= clipEnd);
    const hookWord = clipWords.find((w) => hookPatterns.test(w.word));
    if (hookWord) {
      peakTimeInClip = hookWord.start - clipStart;
    }
  }

  // Don't hook if the peak is in the first 5 seconds (already a good hook)
  if (peakTimeInClip < 5) return false;
  // Don't hook if peak is in the last 3 seconds
  if (peakTimeInClip > clipDuration - 3) return false;

  const hookDuration = 2.5; // seconds of the "spoiler" clip
  const hookStart = Math.max(0, peakTimeInClip - 0.5); // start slightly before peak

  // Paths for temporary segments
  const hookSegPath = path.join(tempDir, `${jobId}_hook_${clipIndex}.mp4`);
  const transitionPath = path.join(tempDir, `${jobId}_transition_${clipIndex}.mp4`);
  const concatListPath = path.join(tempDir, `${jobId}_concat_${clipIndex}.txt`);
  const outputTempPath = path.join(tempDir, `${jobId}_hooked_${clipIndex}.mp4`);

  try {
    // 1. Extract the hook segment (2.5s of the peak moment from rendered clip)
    await runFfmpeg([
      "-y",
      "-ss", hookStart.toFixed(2),
      "-t", hookDuration.toFixed(2),
      "-i", clipPath,
      "-c:v", "libx264", "-preset", "fast", "-crf", clipVideoCrf,
      "-c:a", "aac", "-b:a", clipAudioBitrate,
      "-pix_fmt", "yuv420p",
      hookSegPath,
    ]);

    // 2. Create a brief transition frame (0.8s black with text "Momentos antes...")
    await runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", `color=c=black:s=1080x1920:d=0.8,drawtext=text='Momentos antes...':font=Arial:fontcolor=white@0.85:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`,
      "-f", "lavfi",
      "-i", "anullsrc=r=44100:cl=stereo",
      "-t", "0.8",
      "-c:v", "libx264", "-preset", "fast", "-crf", clipVideoCrf,
      "-c:a", "aac", "-b:a", clipAudioBitrate,
      "-pix_fmt", "yuv420p",
      "-shortest",
      transitionPath,
    ]);

    // 3. Concatenate: hook + transition + full clip
    const concatContent = [
      `file '${hookSegPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`,
      `file '${transitionPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`,
      `file '${clipPath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`,
    ].join("\n");
    await fs.writeFile(concatListPath, concatContent, "utf-8");

    await runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c:v", "libx264", "-preset", clipVideoPreset, "-crf", clipVideoCrf,
      "-c:a", "aac", "-b:a", clipAudioBitrate,
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputTempPath,
    ]);

    // 4. Replace original clip with hooked version
    await fs.rename(outputTempPath, clipPath).catch(async () => {
      await fs.copyFile(outputTempPath, clipPath);
      await fs.rm(outputTempPath, { force: true });
    });

    return true;
  } catch {
    return false;
  } finally {
    // Clean up temp files
    await Promise.all([
      fs.rm(hookSegPath, { force: true }).catch(() => {}),
      fs.rm(transitionPath, { force: true }).catch(() => {}),
      fs.rm(concatListPath, { force: true }).catch(() => {}),
      fs.rm(outputTempPath, { force: true }).catch(() => {}),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Preview Frame / Thumbnail — extract the most engaging frame
// ---------------------------------------------------------------------------
// Uses visual analysis signals to find the highest-energy frame.
// Falls back to the "golden moment" at ~40% into the clip.
// ---------------------------------------------------------------------------

function findBestThumbnailTime(
  clipStart: number,
  clipEnd: number,
  visualSignals: { timestamp: number; viralPotential: number }[],
): number {
  const clipSignals = visualSignals.filter(
    (s) => s.timestamp >= clipStart && s.timestamp <= clipEnd,
  );

  if (clipSignals.length > 0) {
    // Pick the frame with highest viral potential
    const best = clipSignals.reduce((a, b) =>
      a.viralPotential > b.viralPotential ? a : b,
    );
    return best.timestamp;
  }

  // Fallback: 40% into the clip (past the intro, before the outro)
  return clipStart + (clipEnd - clipStart) * 0.4;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function processVideo(input: PipelineInput): Promise<PipelineResult> {
  const jobId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  await ensureStorageFolders();

  // The file is already saved to disk by the route handler (streaming upload).
  // We just rename/move it into our upload directory with a job-specific name.
  const extension =
    path.extname(input.fileName).toLowerCase().replace(/[^a-z0-9.]/g, "") || ".mp4";
  const uploadFilePath = path.join(uploadDir, `${jobId}${extension}`);
  await fs.rename(input.filePath, uploadFilePath).catch(async () => {
    // rename fails across different drives/partitions — fallback to copy+delete
    await fs.copyFile(input.filePath, uploadFilePath);
    await fs.rm(input.filePath, { force: true });
  });
  const fullAudioPath = path.join(tempDir, `${jobId}_full.mp3`);

  try {
    const duration = await getMediaDurationSeconds(uploadFilePath);
    const diagnostics: string[] = [];

    const fallbackTitle = input.title.trim() || "Clip viral";

    // Full-video word timestamps for karaoke subtitles
    let fullVideoWords: TranscriptWord[] = [];

    // Detect video dimensions — auto split-screen for landscape videos
    let srcWidth = 0;
    let srcHeight = 0;
    try {
      const dims = await getMediaDimensions(uploadFilePath);
      srcWidth = dims.width;
      srcHeight = dims.height;
    } catch {
      diagnostics.push("No se pudieron leer las dimensiones del video.");
    }
    const isLandscape = srcWidth > srcHeight && srcWidth > 0;
    // Auto split-screen: apply when video is landscape (16:9, podcast, etc.)
    // Users can force it off via the splitScreen toggle
    const applySplitScreen = isLandscape && (input.splitScreen !== false);

    // Extract compressed audio once — used for full-video transcription
    let fullAudioExtracted = false;
    if (canTranscribe()) {
      try {
        await extractCompressedAudio(uploadFilePath, fullAudioPath);
        fullAudioExtracted = true;
      } catch {
        diagnostics.push("No se pudo extraer el audio del video para transcripcion.");
      }
    }

    // Phase 0: Transcription + Scene detection + Keyframe extraction (parallel)
    let transcriptSegments = [] as Awaited<ReturnType<typeof transcribeVerbose>>["segments"];
    let sceneChanges: number[] = [];
    let keyframes: { path: string; timestamp: number }[] = [];

    // Calculate keyframe interval: ~1 frame every 5s for short videos, 8s for long ones
    const keyframeInterval = duration > 600 ? 8 : 5;
    const maxKeyframes = Math.min(60, Math.ceil(duration / keyframeInterval));

    const [transcriptResult, sceneResult, keyframeResult] = await Promise.allSettled([
      canTranscribe() && fullAudioExtracted
        ? transcribeVerbose(fullAudioPath)
        : Promise.resolve(null),
      detectSceneChangeTimes(uploadFilePath, duration),
      canTranscribe()
        ? extractKeyframes({
            inputPath: uploadFilePath,
            outputDir: framesDir,
            jobId,
            intervalSeconds: keyframeInterval,
            maxFrames: maxKeyframes,
          })
        : Promise.resolve([]),
    ]);

    if (transcriptResult.status === "fulfilled" && transcriptResult.value) {
      transcriptSegments = transcriptResult.value.segments;
      fullVideoWords = transcriptResult.value.words;
    } else if (transcriptResult.status === "rejected") {
      diagnostics.push(`Transcripcion fallida: ${transcriptResult.reason?.message ?? "error desconocido"}`);
    }

    if (sceneResult.status === "fulfilled") {
      sceneChanges = sceneResult.value;
    }

    if (keyframeResult.status === "fulfilled") {
      keyframes = keyframeResult.value;
    } else {
      diagnostics.push("Extraccion de keyframes fallida.");
    }

    // Phase 1: Detect viral moments (LLM-first, heuristic fallback)
    const adSegments = transcriptSegments.length > 0
      ? detectAdSegments(transcriptSegments)
      : [];

    if (adSegments.length > 0) {
      diagnostics.push(`Segmentos de publicidad detectados: ${adSegments.length} (excluidos).`);
    }

    // Phase 1.5: Visual analysis with GPT-4o Vision (if keyframes available)
    let visualAnalysis: VisualAnalysisResult | null = null;
    let visualContextStr = "";

    if (keyframes.length > 0 && canTranscribe()) {
      const transcriptForVisual = transcriptSegments
        .map((s) => `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, "0")}] ${s.text}`)
        .join("\n");

      visualAnalysis = await analyzeVideoVisually({
        frames: keyframes,
        transcriptContext: transcriptForVisual,
        videoDuration: duration,
      });

      if (visualAnalysis) {
        visualContextStr = buildVisualContextForPrompt(visualAnalysis);
        diagnostics.push(
          `Analisis visual: ${visualAnalysis.signals.length} frames analizados, ${visualAnalysis.hotSpots.length} zonas calientes.`,
        );
      } else {
        diagnostics.push("Analisis visual no produjo resultados.");
      }
    }

    // Clean up keyframe files
    for (const kf of keyframes) {
      await fs.rm(kf.path, { force: true }).catch(() => {});
    }

    // Load TikTok benchmark data (if available) to calibrate clip detection
    const benchmarkContext = await loadActiveBenchmarkContext();

    let moments: DetectedMoment[] = [];
    let usedLlmDetection = false;

    if (transcriptSegments.length > 0) {
      // Try LLM-first moment detection (with visual + benchmark context)
      const llmMoments = await detectMomentsWithLlm({
        segments: transcriptSegments,
        sceneChanges,
        adSegments,
        videoDuration: duration,
        maxClips: input.clipCount,
        visualContext: visualContextStr || undefined,
        benchmarkContext: benchmarkContext || undefined,
      });

      if (llmMoments && llmMoments.length > 0) {
        moments = llmMoments;
        usedLlmDetection = true;
      } else {
        // Fallback to heuristic moment detection
        moments = buildHeuristicMoments({
          segments: transcriptSegments,
          sceneChanges,
          adSegments,
          videoDuration: duration,
          maxClips: input.clipCount,
        });
      }
    }

    // If no moments detected (no transcript), fall back to uniform distribution
    if (moments.length === 0) {
      const defaultDuration = 30;
      const starts = buildStarts(duration, input.clipCount, defaultDuration);
      moments = starts.map((start) => ({
        start,
        end: Math.min(start + defaultDuration, duration),
        title: fallbackTitle,
        hookText: "",
        zoomTimestamp: null,
        descriptions: { tiktok: "", instagram: "", youtube: "" },
        scores: { hook: 0, flow: 0, engagement: 0, completeness: 0 },
        overallScore: 0,
        rationale: "Sin transcripcion — distribucion temporal uniforme.",
        transcriptPreview: "",
      }));
    }

    // Apply sentence-boundary snapping to LLM moments
    if (fullVideoWords.length > 0) {
      moments = moments.map((m) => {
        const snapped = snapToSentenceBoundary(fullVideoWords, m.start, m.end);
        // Only apply if the snapped range is still reasonable
        const snappedDuration = snapped.end - snapped.start;
        if (snappedDuration >= 10 && snappedDuration <= 180) {
          return { ...m, start: snapped.start, end: snapped.end };
        }
        return m;
      });
    }

    // Sort moments by score (best first for display), then process
    moments.sort((a, b) => b.overallScore - a.overallScore);

    const fontSize = Math.max(24, Math.min(56, input.subtitleSize));
    const captionPreset = getPreset(input.captionPreset || DEFAULT_PRESET_ID);

    const clipsData = moments.map((m, i) => ({
      moment: m,
      durationForClip: Number((m.end - m.start).toFixed(2)),
      index: i,
    }));

    // Phase 2: Transcribe ALL clips in parallel (I/O-bound API calls)
    const transcriptionResults = await Promise.allSettled(
      clipsData.map(({ moment, durationForClip, index }) =>
        transcribeClipAudio({
          uploadFilePath,
          jobId,
          index,
          start: moment.start,
          durationForClip,
          subtitleFontSize: fontSize,
          captionPreset,
        }),
      ),
    );

    // Phase 2.5: Generate viral titles if LLM didn't provide them, or if autoTitle is on
    let clipTitles: string[] = [];
    if (input.autoTitle && fullVideoWords.length > 0 && titleClient) {
      // Only generate titles for clips that don't already have LLM-generated ones
      const titlePromises = clipsData.map(({ moment }) => {
        if (usedLlmDetection && moment.title && moment.title !== "Clip viral") {
          return Promise.resolve(moment.title);
        }
        const transcript = extractClipTranscript(
          fullVideoWords,
          moment.start,
          moment.end,
        );
        return generateViralTitle(transcript);
      });
      const titleResults = await Promise.allSettled(titlePromises);
      clipTitles = titleResults.map((r) =>
        r.status === "fulfilled" && r.value ? r.value : "",
      );
    }

    // Phase 3: Render clips sequentially (CPU-bound FFmpeg encoding)
    // Resolve watermark image path once (used for all clips)
    const resolvedWatermarkPath = await resolveWatermarkPath(input.watermarkImage);

    const clipResults: ClipResult[] = [];
    let karaokeCount = 0;
    let hookCount = 0;
    let thumbnailCount = 0;

    for (let i = 0; i < clipsData.length; i += 1) {
      const { moment, durationForClip } = clipsData[i];
      const txResult = transcriptionResults[i];
      const { hasSubtitles, subtitlePath, isKaraoke } =
        txResult.status === "fulfilled"
          ? txResult.value
          : {
              hasSubtitles: false,
              subtitlePath: path.join(tempDir, `${jobId}_clip_${i + 1}.ass`),
              isKaraoke: false,
            };

      if (isKaraoke) karaokeCount++;

      // Title: when autoTitle is ON use LLM titles; when OFF use manual title only
      const clipTitle = input.autoTitle
        ? (clipTitles[i] || moment.title || fallbackTitle)
        : fallbackTitle;
      const fileName = outputFileName(jobId, i);
      const finalPath = path.join(outputDir, fileName);

      // Compute zoom position relative to clip start
      const zoomAt = moment.zoomTimestamp != null
        ? moment.zoomTimestamp - moment.start
        : undefined;

      // Render the base clip with hook text overlay, zoom, and anti-copyright
      await renderSingleClip({
        sourceVideoPath: uploadFilePath,
        outputPath: finalPath,
        start: moment.start,
        duration: durationForClip,
        title: clipTitle,
        watermark: input.watermark.trim() || "@viralclips",
        subtitlePath: hasSubtitles ? subtitlePath : null,
        splitScreen: applySplitScreen,
        srcWidth,
        srcHeight,
        hookText: moment.hookText || undefined,
        zoomAt,
        watermarkPath: resolvedWatermarkPath,
      });

      // Hook optimizer: prepend the most impactful 2-3s as a "spoiler hook"
      let hookApplied = false;
      if (input.hookOptimizer && durationForClip > 15) {
        try {
          hookApplied = await applyHookOptimizer({
            clipPath: finalPath,
            sourceVideoPath: uploadFilePath,
            clipStart: moment.start,
            clipDuration: durationForClip,
            visualSignals: visualAnalysis?.signals ?? [],
            words: fullVideoWords,
            jobId,
            clipIndex: i,
          });
          if (hookApplied) hookCount++;
        } catch {
          diagnostics.push(`Hook optimizer fallo en clip ${i + 1}.`);
        }
      }

      // Extract thumbnail: best frame from the clip
      let thumbnailUrl: string | undefined;
      try {
        const thumbName = `${jobId}_thumb_${String(i + 1).padStart(2, "0")}.jpg`;
        const thumbPath = path.join(outputDir, thumbName);
        const bestTime = findBestThumbnailTime(
          moment.start,
          moment.start + durationForClip,
          visualAnalysis?.signals ?? [],
        );
        const seekTime = bestTime - moment.start; // relative to clip start

        await runFfmpeg([
          "-y",
          "-ss", Math.max(0, seekTime).toFixed(2),
          "-i", finalPath,
          "-frames:v", "1",
          "-q:v", "3",
          thumbPath,
        ]);
        thumbnailUrl = `/api/download/${encodeURIComponent(thumbName)}`;
        thumbnailCount++;
      } catch {
        // Thumbnail extraction failed, not critical
      }

      if (hasSubtitles) {
        await fs.rm(subtitlePath, { force: true });
      }

      clipResults.push({
        fileName,
        url: `/api/download/${encodeURIComponent(fileName)}`,
        startSeconds: moment.start,
        durationSeconds: durationForClip,
        hasSubtitles,
        scores: moment.scores,
        overallScore: moment.overallScore,
        rationale: moment.rationale,
        title: clipTitle,
        hookText: moment.hookText ?? "",
        descriptions: moment.descriptions ?? { tiktok: "", instagram: "", youtube: "" },
        thumbnailUrl,
        hookApplied,
      });
    }

    const subtitleCount = clipResults.filter((c) => c.hasSubtitles).length;

    // Preserve source video for the editor
    const safeJobId = sanitizeName(jobId);
    const sourcePreservePath = path.join(sourcesDir, `${safeJobId}${extension}`);
    await fs.copyFile(uploadFilePath, sourcePreservePath).catch(() => {
      diagnostics.push("No se pudo preservar el video fuente para el editor.");
    });

    const notes = [
      canTranscribe()
        ? subtitleCount > 0
          ? `Subtitulos generados con OpenAI en ${subtitleCount}/${clipResults.length} clips.`
          : "OpenAI disponible pero sin subtitulos generados en este lote."
        : "Sin OPENAI_API_KEY: clips generados con titulo y marca de agua.",
      karaokeCount > 0
        ? `Subtitulos karaoke (word-by-word) en ${karaokeCount}/${subtitleCount} clips.`
        : "Subtitulos karaoke no disponibles (sin timestamps de palabra).",
      usedLlmDetection
        ? visualAnalysis
          ? `Deteccion multimodal (audio + vision): GPT-4o analizo transcripcion + ${visualAnalysis.signals.length} frames visuales para identificar ${moments.length} momentos.`
          : `Deteccion de momentos con GPT-4o: ${moments.length} momentos virales identificados con duracion variable.`
        : transcriptSegments.length > 0
          ? "Deteccion heuristica: momentos seleccionados por densidad y engagement."
          : "Sin transcripcion disponible: distribucion temporal uniforme.",
      applySplitScreen
        ? `Split-screen activado (${srcWidth}x${srcHeight}).`
        : input.splitScreen
          ? "Split-screen solicitado pero el video no es landscape."
          : "Split-screen desactivado.",
      `Caption preset: ${captionPreset.name}.`,
      hookCount > 0
        ? `Hook optimizer aplicado en ${hookCount}/${clipResults.length} clips.`
        : input.hookOptimizer
          ? "Hook optimizer activado pero no aplicado (clips muy cortos)."
          : "Hook optimizer desactivado.",
      thumbnailCount > 0
        ? `Thumbnails generados: ${thumbnailCount}/${clipResults.length}.`
        : "Sin thumbnails generados.",
      benchmarkContext
        ? "Benchmark TikTok activo: scoring calibrado con datos reales."
        : "Sin benchmark TikTok: scoring basado en criterios del LLM.",
      `Render: preset=${clipVideoPreset} crf=${clipVideoCrf} audio=${clipAudioBitrate}.`,
      sceneChanges.length > 0
        ? `Cambios de escena detectados: ${sceneChanges.length}.`
        : "Sin cambios de escena detectados.",
      ...diagnostics,
      "Anti-copyright: pitch shift +2%, color shift, watermark overlay.",
      "Formato de salida: vertical 1080x1920.",
    ];

    // Save job manifest for the post-generation editor
    const manifest: JobManifest = {
      jobId: safeJobId,
      sourceVideoPath: sourcePreservePath,
      sourceFileName: input.fileName,
      clips: clipResults,
      words: fullVideoWords,
      visualAnalysis: visualAnalysis
        ? {
            summary: visualAnalysis.summary,
            hotSpots: visualAnalysis.hotSpots,
            signalCount: visualAnalysis.signals.length,
          }
        : undefined,
      settings: {
        watermark: input.watermark.trim() || "@viralclips",
        subtitleSize: fontSize,
        splitScreen: applySplitScreen,
        captionPreset: captionPreset.id,
        hookOptimizer: input.hookOptimizer,
        watermarkImage: input.watermarkImage || "none",
      },
      notes,
      createdAt: new Date().toISOString(),
    };

    const manifestPath = path.join(jobsDir, `${safeJobId}.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    return {
      jobId: safeJobId,
      clips: clipResults,
      notes,
    };
  } finally {
    await Promise.all([
      fs.rm(uploadFilePath, { force: true }),
      fs.rm(fullAudioPath, { force: true }),
    ]);
  }
}
