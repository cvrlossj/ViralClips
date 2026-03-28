import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildHeuristicMoments,
  detectAdSegments,
  detectMomentsWithLlm,
  detectSceneChangeTimes,
  evaluateMomentBeats,
  refineMomentsWithNarrativeContext,
  type BeatEvaluation,
  type ClipScores,
  type DetectedMoment,
} from "@/lib/clip-ranking";
import {
  detectActiveCropArea,
  ensureTextForDrawText,
  extractCompressedAudio,
  extractKeyframes,
  getMediaDimensions,
  getMediaDurationSeconds,
  getMediaStreamInfo,
  runFfmpeg,
} from "@/lib/ffmpeg";
import { benchmarksDir, framesDir, jobsDir, outputDir, sourcesDir, storageRoot, tempDir, uploadDir } from "@/lib/paths";
import {
  analyzeVideoVisually,
  buildVisualContextForPrompt,
  type VisualAnalysisResult,
} from "@/lib/visual-analysis";
import {
  buildBenchmarkPromptContext,
  type ViralBenchmark,
} from "@/lib/tiktok-analytics";
import {
  formatAdaptiveProfileSummary,
  readAdaptiveScoringProfile,
  type AdaptiveScoringProfile,
} from "@/lib/adaptive-learning";
import {
  canTranscribe,
  transcribeVerbose,
  type TranscriptWord,
} from "@/lib/transcription";

type PipelineInput = {
  /** Path to the video file already saved on disk */
  filePath: string;
  /** Original file name (for extension detection) */
  fileName: string;
  clipCount: number;
  splitScreen: boolean;
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
  variantUsed?: NarrativeVariantKind;
  narrativeScore?: number;
  beatSummary?: string;
  qualityFlags?: string[];
  qualityGateStatus?: "pass" | "review";
  qualityGateScore?: number;
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
    splitScreen: boolean;
    hookOptimizer: boolean;
    watermarkImage: string;
    sourceCropFilter?: string;
  };
  notes: string[];
  createdAt: string;
};

const clipVideoPreset = process.env.CLIP_VIDEO_PRESET ?? "medium";
const clipVideoCrf = process.env.CLIP_VIDEO_CRF ?? "18";
const clipAudioBitrate = process.env.CLIP_AUDIO_BITRATE ?? "192k";

function readDurationEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

const MIN_FINAL_CLIP_DURATION_SEC = readDurationEnv("CLIP_MIN_DURATION_SECONDS", 36, 20, 120);

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

function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

function countNarrativeAdjustments(before: DetectedMoment[], after: DetectedMoment[]): number {
  if (before.length === 0 || after.length === 0) return 0;

  let adjusted = 0;

  for (const refined of after) {
    let best: DetectedMoment | null = null;
    let bestOverlap = -1;

    for (const original of before) {
      const overlap = overlapSeconds(refined.start, refined.end, original.start, original.end);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = original;
      }
    }

    if (!best) {
      adjusted += 1;
      continue;
    }

    const startDiff = Math.abs(best.start - refined.start);
    const endDiff = Math.abs(best.end - refined.end);
    if (startDiff >= 1 || endDiff >= 1) {
      adjusted += 1;
    }
  }

  return adjusted;
}

type NarrativeVariantKind = "safe" | "balanced" | "aggressive";

type NarrativeVariantCandidate = {
  kind: NarrativeVariantKind;
  moment: DetectedMoment;
  beat: BeatEvaluation;
  narrativeScore: number;
  engagementScore: number;
  overallScore: number;
  discardedByAntiFlat: boolean;
  qualityGateStatus: "pass" | "review";
  qualityGateScore: number;
  qualityGateIssues: string[];
};

type SelectedMoment = {
  moment: DetectedMoment;
  variantUsed?: NarrativeVariantKind;
  narrativeScore?: number;
  beatSummary?: string;
  qualityFlags?: string[];
  qualityGateStatus?: "pass" | "review";
  qualityGateScore?: number;
};

function mergeClipScores(
  base: ClipScores,
  beat: BeatEvaluation,
  profile: AdaptiveScoringProfile,
): ClipScores {
  const mergeWeights = profile.weights.mergeClipScores;
  return {
    hook: clamp(
      Math.round(base.hook * mergeWeights.hook.base + beat.hookScore * mergeWeights.hook.beat),
      0,
      100,
    ),
    flow: clamp(
      Math.round(base.flow * mergeWeights.flow.base + beat.narrativeScore * mergeWeights.flow.beat),
      0,
      100,
    ),
    engagement: clamp(
      Math.round(base.engagement * mergeWeights.engagement.base + beat.engagementScore * mergeWeights.engagement.beat),
      0,
      100,
    ),
    completeness: clamp(
      Math.round(
        base.completeness * mergeWeights.completeness.base +
        beat.completenessScore * mergeWeights.completeness.beat,
      ),
      0,
      100,
    ),
  };
}

function buildNarrativeVariantWindow(params: {
  moment: DetectedMoment;
  beat: BeatEvaluation;
  kind: NarrativeVariantKind;
  videoDuration: number;
}) {
  const { moment, beat, kind, videoDuration } = params;
  const baseDuration = Math.max(moment.end - moment.start, MIN_FINAL_CLIP_DURATION_SEC);
  const safeBoost = Math.max(6, Math.round(baseDuration * 0.15));
  const aggressiveTrim = Math.max(4, Math.round(baseDuration * 0.08));

  const duration = kind === "safe"
    ? clamp(baseDuration + safeBoost, MIN_FINAL_CLIP_DURATION_SEC, 180)
    : kind === "balanced"
      ? clamp(baseDuration + (beat.completenessScore < 68 ? 4 : 0), MIN_FINAL_CLIP_DURATION_SEC, 180)
      : clamp(baseDuration - aggressiveTrim, MIN_FINAL_CLIP_DURATION_SEC, 180);

  const anchorFraction = kind === "safe"
    ? 0.58
    : kind === "balanced"
      ? 0.5
      : 0.42;

  let start = beat.anchorTimestamp - duration * anchorFraction;
  let end = start + duration;

  if (start < 0) {
    end -= start;
    start = 0;
  }

  if (end > videoDuration) {
    const delta = end - videoDuration;
    start = Math.max(0, start - delta);
    end = videoDuration;
  }

  if (end - start < MIN_FINAL_CLIP_DURATION_SEC) {
    end = Math.min(videoDuration, start + MIN_FINAL_CLIP_DURATION_SEC);
    start = Math.max(0, end - MIN_FINAL_CLIP_DURATION_SEC);
  }

  return {
    start: round2(start),
    end: round2(end),
  };
}

function buildNarrativeVariantMoment(params: {
  moment: DetectedMoment;
  beat: BeatEvaluation;
  kind: NarrativeVariantKind;
  videoDuration: number;
  words: TranscriptWord[];
}): DetectedMoment {
  const { moment, beat, kind, videoDuration, words } = params;
  const rawWindow = buildNarrativeVariantWindow({ moment, beat, kind, videoDuration });
  const snapped = words.length > 0
    ? snapToSentenceBoundary(words, rawWindow.start, rawWindow.end)
    : rawWindow;

  let start = snapped.start;
  let end = snapped.end;

  if (end - start < MIN_FINAL_CLIP_DURATION_SEC) {
    start = rawWindow.start;
    end = rawWindow.end;
  }

  start = clamp(round2(start), 0, Math.max(0, videoDuration - MIN_FINAL_CLIP_DURATION_SEC));
  end = clamp(round2(end), Math.min(videoDuration, start + MIN_FINAL_CLIP_DURATION_SEC), videoDuration);

  if (end - start < MIN_FINAL_CLIP_DURATION_SEC) {
    end = Math.min(videoDuration, start + MIN_FINAL_CLIP_DURATION_SEC);
    start = Math.max(0, end - MIN_FINAL_CLIP_DURATION_SEC);
  }

  const zoomTimestamp = clamp(beat.anchorTimestamp, start, end);
  const rationaleSuffix = `variante ${kind} · beats ${beat.summary}`;

  return {
    ...moment,
    start,
    end,
    zoomTimestamp: round2(zoomTimestamp),
    rationale: moment.rationale
      ? `${moment.rationale} | ${rationaleSuffix}`
      : rationaleSuffix,
  };
}

function scoreNarrativeVariant(params: {
  moment: DetectedMoment;
  beat: BeatEvaluation;
  kind: NarrativeVariantKind;
  profile: AdaptiveScoringProfile;
}) {
  const { moment, beat, kind, profile } = params;
  const variantWeights = profile.weights.variant;
  const narrativeScore = clamp(
    Math.round(
      beat.narrativeScore * variantWeights.narrative.narrative +
      beat.completenessScore * variantWeights.narrative.completeness +
      beat.beatCoverageScore * variantWeights.narrative.beatCoverage +
      moment.scores.flow * variantWeights.narrative.flow,
    ),
    0,
    100,
  );
  const engagementScore = clamp(
    Math.round(
      beat.engagementScore * variantWeights.engagement.beatEngagement +
      beat.hookScore * variantWeights.engagement.beatHook +
      moment.scores.engagement * variantWeights.engagement.momentEngagement,
    ),
    0,
    100,
  );
  const kindBias =
    kind === "safe"
      ? variantWeights.kindBias.safe
      : kind === "balanced"
        ? variantWeights.kindBias.balanced
        : variantWeights.kindBias.aggressive;
  const flatPenalty = beat.flatRisk ? variantWeights.flatPenalty : 0;
  const overallScore = clamp(
    Math.round(
      narrativeScore * variantWeights.overall.narrative +
      engagementScore * variantWeights.overall.engagement +
      kindBias -
      flatPenalty,
    ),
    0,
    100,
  );

  return { narrativeScore, engagementScore, overallScore };
}

function isAntiFlatBeat(evaluation: BeatEvaluation, profile: AdaptiveScoringProfile) {
  const antiFlat = profile.weights.antiFlat;
  return (
    evaluation.flatRisk ||
    (evaluation.hookScore < antiFlat.hookFloor && evaluation.completenessScore < antiFlat.completenessFloor)
  );
}

function evaluateNarrativeQualityGate(params: {
  beat: BeatEvaluation;
  narrativeScore: number;
  engagementScore: number;
  profile: AdaptiveScoringProfile;
}): { status: "pass" | "review"; score: number; issues: string[] } {
  const { beat, narrativeScore, engagementScore, profile } = params;
  const gate = profile.weights.qualityGate;
  const issues: string[] = [];

  if (beat.hookScore < gate.thresholds.hook) issues.push("hook-bajo");
  if (beat.completenessScore < gate.thresholds.completeness) issues.push("completitud-baja");
  if (beat.missingBeats.includes("payoff")) issues.push("sin-payoff");
  if (beat.missingBeats.includes("reaction")) issues.push("sin-reaccion");
  if (narrativeScore < gate.thresholds.narrative) issues.push("narrativa-baja");
  if (engagementScore < gate.thresholds.engagement) issues.push("engagement-bajo");

  const penalty = issues.length * gate.issuePenalty;
  const score = clamp(
    Math.round(
      beat.completenessScore * gate.blend.completeness +
      narrativeScore * gate.blend.narrative +
      engagementScore * gate.blend.engagement +
      beat.hookScore * gate.blend.hook -
      penalty,
    ),
    0,
    100,
  );

  const pass = score >= gate.passMinScore && !issues.includes("sin-payoff") && !issues.includes("sin-reaccion");
  return {
    status: pass ? "pass" : "review",
    score,
    issues,
  };
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
  splitScreen: boolean;
  srcWidth: number;
  srcHeight: number;
  /** Hook text overlay (shown first 3s) */
  hookText?: string;
  /** Zoom timestamp relative to clip start (seconds) */
  zoomAt?: number;
  /** Absolute path to watermark PNG (or null to skip) */
  watermarkPath?: string | null;
  /** Pre-crop filter to remove baked black bars before the rest of the pipeline */
  sourceCropFilter?: string | null;
}): Promise<void> {
  const { sourceVideoPath, outputPath, start, duration, splitScreen } = params;

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

  // Build overlay filters (hook text + color shift)
  function buildOverlayFilters(): string[] {
    const f: string[] = [];
    f.push(colorShiftFilter);
    if (hookTextFilter) f.push(hookTextFilter);
    return f;
  }

  const sourceCropPrefix = params.sourceCropFilter ? `${params.sourceCropFilter},` : "";

  if (applySplit) {
    const halfH = Math.floor(OUT_H / 2);
    const splitCropWidthExpr = "trunc(ih*9/8)";
    const overlayFilters = buildOverlayFilters();
    overlayFilters.push(
      `drawbox=x=0:y=${halfH - 2}:w=iw:h=4:color=white@0.4:t=fill`,
      "setsar=1",
    );

    const overlayChain = overlayFilters.length > 0 ? `,${overlayFilters.join(",")}` : "";

    // Build inputs
    const inputs = [
      "-y", "-ss", start.toFixed(2), "-t", duration.toFixed(2),
      "-i", sourceVideoPath,
    ];

    const splitSourceLabel = params.sourceCropFilter ? "[prep]" : "[0:v]";

    let filterComplex: string;
    if (hasWatermark) {
      inputs.push("-i", watermarkPath!);
      const parts = [
        ...(params.sourceCropFilter ? [`[0:v]${params.sourceCropFilter}[prep]`] : []),
        `${splitSourceLabel}split[a][b]`,
        `[a]crop=${splitCropWidthExpr}:ih:0:0,scale=${OUT_W}:${halfH}:flags=lanczos,setsar=1[left]`,
        `[b]crop=${splitCropWidthExpr}:ih:iw-${splitCropWidthExpr}:0,scale=${OUT_W}:${halfH}:flags=lanczos,setsar=1[right]`,
        `[left][right]vstack${overlayChain}[stacked]`,
        `[1:v]scale=160:-1,format=rgba,colorchannelmixer=aa=0.7[wm]`,
        `[stacked][wm]overlay=W-w-30:H-h-30[out]`,
      ];
      filterComplex = parts.join(";");
    } else {
      const parts = [
        ...(params.sourceCropFilter ? [`[0:v]${params.sourceCropFilter}[prep]`] : []),
        `${splitSourceLabel}split[a][b]`,
        `[a]crop=${splitCropWidthExpr}:ih:0:0,scale=${OUT_W}:${halfH}:flags=lanczos,setsar=1[left]`,
        `[b]crop=${splitCropWidthExpr}:ih:iw-${splitCropWidthExpr}:0,scale=${OUT_W}:${halfH}:flags=lanczos,setsar=1[right]`,
        `[left][right]vstack${overlayChain}[out]`,
      ];
      filterComplex = parts.join(";");
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
      ? `${sourceCropPrefix}scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,${zoomFilter}`
      : `${sourceCropPrefix}scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1`;

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
  const adaptiveProfile = await readAdaptiveScoringProfile();

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

    const fallbackTitle = "Clip viral";

    // Full-video word timestamps for sentence snapping and hook analysis
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
    const aspectRatio = srcHeight > 0 ? srcWidth / srcHeight : 0;
    // Auto split-screen only on clearly wide sources to avoid awkward crops.
    const applySplitScreen = input.splitScreen && aspectRatio >= 1.5 && srcWidth >= 1280;

    let sourceCropFilter: string | null = null;
    try {
      const crop = await detectActiveCropArea({ filePath: uploadFilePath });
      if (crop) {
        sourceCropFilter = crop.filter;
        diagnostics.push(
          `Auto-crop activo detectado: ${crop.width}x${crop.height}+${crop.x}+${crop.y}.`,
        );
      }
    } catch {
      diagnostics.push("No se pudo analizar auto-crop del video fuente.");
    }

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
    let narrativeAdjustedCount = 0;

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
      const defaultDuration = Math.max(MIN_FINAL_CLIP_DURATION_SEC, 36);
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

    // Narrative refinement pass:
    // expands setup + reaction around the peak moment to avoid abrupt cuts.
    if (moments.length > 0 && transcriptSegments.length > 0) {
      const beforeRefine = [...moments];
      moments = refineMomentsWithNarrativeContext({
        moments,
        segments: transcriptSegments,
        adSegments,
        sceneChanges,
        videoDuration: duration,
        maxClips: input.clipCount,
      });
      narrativeAdjustedCount = countNarrativeAdjustments(beforeRefine, moments);
    }

    // Apply sentence-boundary snapping to LLM moments
    if (fullVideoWords.length > 0) {
      moments = moments.map((m) => {
        const snapped = snapToSentenceBoundary(fullVideoWords, m.start, m.end);
        // Only apply if the snapped range is still reasonable
        const snappedDuration = snapped.end - snapped.start;
        if (snappedDuration >= MIN_FINAL_CLIP_DURATION_SEC && snappedDuration <= 180) {
          return { ...m, start: snapped.start, end: snapped.end };
        }
        return m;
      });
    }

    let variantReplacedCount = 0;
    let antiFlatDiscardCount = 0;
    let antiFlatFallbackCount = 0;
    let qualityGateFallbackCount = 0;
    let selectedMoments: SelectedMoment[] = moments.map((moment) => ({ moment }));

    if (transcriptSegments.length > 0 && moments.length > 0) {
      const variantKinds: NarrativeVariantKind[] = ["safe", "balanced", "aggressive"];
      const variantSelected: SelectedMoment[] = [];

      for (const baseMoment of moments) {
        const baseBeat = evaluateMomentBeats({
          moment: baseMoment,
          segments: transcriptSegments,
          sceneChanges,
        });

        const candidates: NarrativeVariantCandidate[] = variantKinds.map((kind) => {
          const variantMoment = buildNarrativeVariantMoment({
            moment: baseMoment,
            beat: baseBeat,
            kind,
            videoDuration: duration,
            words: fullVideoWords,
          });
          const variantBeat = evaluateMomentBeats({
            moment: variantMoment,
            segments: transcriptSegments,
            sceneChanges,
          });
          const variantScores = scoreNarrativeVariant({
            moment: variantMoment,
            beat: variantBeat,
            kind,
            profile: adaptiveProfile,
          });
          const qualityGate = evaluateNarrativeQualityGate({
            beat: variantBeat,
            narrativeScore: variantScores.narrativeScore,
            engagementScore: variantScores.engagementScore,
            profile: adaptiveProfile,
          });

          return {
            kind,
            moment: {
              ...variantMoment,
              scores: mergeClipScores(variantMoment.scores, variantBeat, adaptiveProfile),
              overallScore: variantScores.overallScore,
            },
            beat: variantBeat,
            narrativeScore: variantScores.narrativeScore,
            engagementScore: variantScores.engagementScore,
            overallScore: variantScores.overallScore,
            discardedByAntiFlat: isAntiFlatBeat(variantBeat, adaptiveProfile),
            qualityGateStatus: qualityGate.status,
            qualityGateScore: qualityGate.score,
            qualityGateIssues: qualityGate.issues,
          };
        });

        const viableCandidates = candidates.filter((candidate) => !candidate.discardedByAntiFlat);
        antiFlatDiscardCount += candidates.length - viableCandidates.length;
        const gateCandidates = viableCandidates.filter((candidate) => candidate.qualityGateStatus === "pass");
        if (viableCandidates.length > 0 && gateCandidates.length === 0) {
          qualityGateFallbackCount += 1;
        }
        const candidatePool =
          gateCandidates.length > 0
            ? gateCandidates
            : viableCandidates.length > 0
              ? viableCandidates
              : candidates;
        if (viableCandidates.length === 0) {
          antiFlatFallbackCount += 1;
        }

        const selected = candidatePool.reduce((best, candidate) => {
          if (candidate.overallScore !== best.overallScore) {
            return candidate.overallScore > best.overallScore ? candidate : best;
          }
          if (candidate.narrativeScore !== best.narrativeScore) {
            return candidate.narrativeScore > best.narrativeScore ? candidate : best;
          }
          if (candidate.engagementScore !== best.engagementScore) {
            return candidate.engagementScore > best.engagementScore ? candidate : best;
          }
          const order: Record<NarrativeVariantKind, number> = {
            safe: 0,
            balanced: 1,
            aggressive: 2,
          };
          return order[candidate.kind] < order[best.kind] ? candidate : best;
        });

        const changedWindow =
          Math.abs(selected.moment.start - baseMoment.start) > 0.25 ||
          Math.abs(selected.moment.end - baseMoment.end) > 0.25;
        if (selected.kind !== "balanced" || changedWindow) {
          variantReplacedCount += 1;
        }

        const qualityFlags: string[] = [];
        if (selected.discardedByAntiFlat) {
          qualityFlags.push("anti-flat:fallback");
        }
        if (selected.qualityGateStatus !== "pass") {
          qualityFlags.push("quality-gate:review");
        } else {
          qualityFlags.push("quality-gate:pass");
        }
        if (selected.qualityGateIssues.length > 0) {
          qualityFlags.push(...selected.qualityGateIssues.slice(0, 2));
        }
        if (selected.beat.missingBeats.includes("payoff")) {
          qualityFlags.push("sin-payoff-claro");
        }
        if (selected.beat.hookScore < 45) {
          qualityFlags.push("hook-inicial-debil");
        }
        if (selected.beat.completenessScore < 60) {
          qualityFlags.push("completitud-media");
        }

        variantSelected.push({
          moment: selected.moment,
          variantUsed: selected.kind,
          narrativeScore: selected.narrativeScore,
          beatSummary: selected.beat.summary,
          qualityFlags: qualityFlags.length > 0 ? qualityFlags : undefined,
          qualityGateStatus: selected.qualityGateStatus,
          qualityGateScore: selected.qualityGateScore,
        });
      }

      selectedMoments = variantSelected;
    }

    selectedMoments = selectedMoments.map((selection) => {
      const moment = selection.moment;
      if (moment.end - moment.start < MIN_FINAL_CLIP_DURATION_SEC) {
        const end = Math.min(duration, moment.start + MIN_FINAL_CLIP_DURATION_SEC);
        const start = Math.max(0, end - MIN_FINAL_CLIP_DURATION_SEC);
        return {
          ...selection,
          moment: { ...moment, start: round2(start), end: round2(end) },
        };
      }
      return selection;
    });

    moments = selectedMoments.map((selection) => selection.moment);

    // Sort moments by score (best first for display), then process
    selectedMoments.sort((a, b) => b.moment.overallScore - a.moment.overallScore);
    moments = selectedMoments.map((selection) => selection.moment);

    const clipsData = selectedMoments.map((selection, i) => ({
      moment: selection.moment,
      variantUsed: selection.variantUsed,
      narrativeScore: selection.narrativeScore,
      beatSummary: selection.beatSummary,
      qualityFlags: selection.qualityFlags,
      qualityGateStatus: selection.qualityGateStatus,
      qualityGateScore: selection.qualityGateScore,
      durationForClip: Number((selection.moment.end - selection.moment.start).toFixed(2)),
      index: i,
    }));

    // Phase 2: Render clips sequentially (CPU-bound FFmpeg encoding)
    // Resolve watermark image path once (used for all clips)
    const resolvedWatermarkPath = await resolveWatermarkPath(input.watermarkImage);

    const clipResults: ClipResult[] = [];
    let hookCount = 0;
    let thumbnailCount = 0;
    let qualityGatePassCount = 0;
    let qualityGateReviewCount = 0;

    for (let i = 0; i < clipsData.length; i += 1) {
      const {
        moment,
        durationForClip,
        variantUsed,
        narrativeScore,
        beatSummary,
        qualityFlags,
        qualityGateStatus,
        qualityGateScore,
      } = clipsData[i];
      const clipTitle = moment.title || fallbackTitle;
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
        splitScreen: applySplitScreen,
        srcWidth,
        srcHeight,
        hookText: moment.hookText || undefined,
        zoomAt,
        watermarkPath: resolvedWatermarkPath,
        sourceCropFilter,
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

      let finalGateStatus: "pass" | "review" = qualityGateStatus ?? "review";
      let finalGateScore = qualityGateScore ?? 0;
      const finalQualityFlags = [...(qualityFlags ?? [])];
      try {
        const streamInfo = await getMediaStreamInfo(finalPath);
        const technicalIssues: string[] = [];

        if (streamInfo.width !== 1080 || streamInfo.height !== 1920) {
          technicalIssues.push(`formato-${streamInfo.width}x${streamInfo.height}`);
        }
        if (streamInfo.duration < MIN_FINAL_CLIP_DURATION_SEC - 1) {
          technicalIssues.push(`duracion-corta-${streamInfo.duration.toFixed(1)}s`);
        }
        if (!streamInfo.hasAudio) {
          technicalIssues.push("sin-audio");
        }

        if (technicalIssues.length > 0) {
          finalGateStatus = "review";
          finalGateScore = clamp(finalGateScore - technicalIssues.length * 10, 0, 100);
          finalQualityFlags.push(...technicalIssues.slice(0, 2));
        } else {
          finalGateScore = clamp(finalGateScore + 6, 0, 100);
        }
      } catch {
        finalGateStatus = "review";
        finalQualityFlags.push("verificacion-tecnica-fallo");
      }

      if (finalGateStatus === "pass") {
        qualityGatePassCount += 1;
      } else {
        qualityGateReviewCount += 1;
      }

      clipResults.push({
        fileName,
        url: `/api/download/${encodeURIComponent(fileName)}`,
        startSeconds: moment.start,
        durationSeconds: durationForClip,
        hasSubtitles: false,
        scores: moment.scores,
        overallScore: moment.overallScore,
        rationale: moment.rationale,
        title: clipTitle,
        hookText: moment.hookText ?? "",
        descriptions: moment.descriptions ?? { tiktok: "", instagram: "", youtube: "" },
        thumbnailUrl,
        hookApplied,
        variantUsed,
        narrativeScore,
        beatSummary,
        qualityFlags: finalQualityFlags.length > 0 ? finalQualityFlags : undefined,
        qualityGateStatus: finalGateStatus,
        qualityGateScore: finalGateScore,
      });
    }

    // Preserve source video for the editor
    const safeJobId = sanitizeName(jobId);
    const sourcePreservePath = path.join(sourcesDir, `${safeJobId}${extension}`);
    await fs.copyFile(uploadFilePath, sourcePreservePath).catch(() => {
      diagnostics.push("No se pudo preservar el video fuente para el editor.");
    });

    const notes = [
      "Overlay de subtitulos y titulo desactivado para edicion externa (CapCut).",
      `Duracion minima objetivo por clip: ${MIN_FINAL_CLIP_DURATION_SEC}s (si el metraje lo permite).`,
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
          ? "Split-screen solicitado pero el video no cumple ratio/resolucion minima."
          : "Split-screen desactivado.",
      sourceCropFilter
        ? "Auto-crop activo para eliminar franjas negras del video fuente."
        : "Auto-crop no necesario o no detectado.",
      narrativeAdjustedCount > 0
        ? `Refinado narrativo aplicado en ${narrativeAdjustedCount}/${moments.length} clips (setup + payoff + reaccion).`
        : transcriptSegments.length > 0
          ? "Refinado narrativo activo: no fue necesario ajustar cortes en esta corrida."
          : "Refinado narrativo omitido por falta de transcripcion.",
      transcriptSegments.length > 0
        ? `Variantes narrativas: ${variantReplacedCount}/${moments.length} clips reemplazados por safe/balanced/aggressive.`
        : "Variantes narrativas omitidas por falta de transcripcion.",
      transcriptSegments.length > 0
        ? `Filtro anti-plano: descarto ${antiFlatDiscardCount} variantes${antiFlatFallbackCount > 0 ? ` y activo fallback en ${antiFlatFallbackCount} momentos.` : "."}`
        : "Filtro anti-plano omitido por falta de transcripcion.",
      `Quality Gate: ${qualityGatePassCount}/${clipResults.length} clips en PASS; ${qualityGateReviewCount} en REVIEW.`,
      transcriptSegments.length > 0 && qualityGateFallbackCount > 0
        ? `Quality Gate narrativo activo fallback en ${qualityGateFallbackCount} momentos (sin variante que cumpla todo).`
        : "Quality Gate narrativo aplicado sin fallback.",
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
      formatAdaptiveProfileSummary(adaptiveProfile),
      `Render: preset=${clipVideoPreset} crf=${clipVideoCrf} audio=${clipAudioBitrate}.`,
      sceneChanges.length > 0
        ? `Cambios de escena detectados: ${sceneChanges.length}.`
        : "Sin cambios de escena detectados.",
      "Scene smoothing activo: cortes guiados por narrativa + boundaries de escena menos agresivos.",
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
        splitScreen: applySplitScreen,
        hookOptimizer: input.hookOptimizer,
        watermarkImage: input.watermarkImage || "none",
        sourceCropFilter: sourceCropFilter ?? undefined,
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
