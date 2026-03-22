import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildCandidateWindows,
  detectAdSegments,
  detectSceneChangeTimes,
  isWindowInAdSegment,
  pickHeuristicWindows,
  rerankWithLlm,
  type AdSegment,
} from "@/lib/clip-ranking";
import {
  ensurePathForSubtitlesFilter,
  ensureTextForDrawText,
  extractCompressedAudio,
  getMediaDimensions,
  getMediaDurationSeconds,
  runFfmpeg,
} from "@/lib/ffmpeg";
import { outputDir, tempDir, uploadDir } from "@/lib/paths";
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
  file: File;
  title: string;
  watermark: string;
  clipCount: number;
  clipDuration: number;
  smartMode: boolean;
  subtitleSize: number;
  splitScreen: boolean;
  autoTitle: boolean;
};

type ClipResult = {
  fileName: string;
  url: string;
  startSeconds: number;
  durationSeconds: number;
  hasSubtitles: boolean;
  score: number;
  rationale: string;
  title: string;
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
// ASS subtitle generation — karaoke word-by-word highlighting
// ---------------------------------------------------------------------------
// Groups words into lines of WORDS_PER_LINE, then creates one ASS Dialogue
// per word showing the full line with the current word highlighted in yellow
// and the rest in white.
// ---------------------------------------------------------------------------

const WORDS_PER_LINE = 3;

function assTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function wordsToKaraokeAss(words: TranscriptWord[], fontSize: number): string {
  if (words.length === 0) return "";

  // Group words into lines
  const lines: TranscriptWord[][] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_LINE) {
    lines.push(words.slice(i, i + WORDS_PER_LINE));
  }

  const dialogues: string[] = [];

  for (const line of lines) {
    const lineStart = line[0].start;
    const lineEnd = line[line.length - 1].end;

    // For each word in the line, create a dialogue event that shows the full
    // line but highlights the current word.
    for (let wi = 0; wi < line.length; wi++) {
      const w = line[wi];
      const wordStart = w.start;
      const wordEnd = wi < line.length - 1 ? line[wi + 1].start : lineEnd;

      // Build text with override tags
      const parts = line.map((lw, li) => {
        const clean = lw.word.replace(/\\/g, "");
        if (li === wi) {
          // Current word: yellow highlight (ASS uses BGR: 00FFFF = yellow)
          return `{\\1c&H00FFFF&\\b1}${clean}{\\1c&HFFFFFF&\\b1}`;
        }
        return clean;
      });

      dialogues.push(
        `Dialogue: 0,${assTime(wordStart)},${assTime(wordEnd)},Default,,0,0,0,,${parts.join(" ")}`,
      );
    }
  }

  const styleLine = [
    "Default",
    "Arial",
    String(fontSize),
    "&H00FFFFFF",       // PrimaryColour (white)
    "&H000000FF",       // SecondaryColour
    "&H00000000",       // OutlineColour (black)
    "&H80000000",       // BackColour (semi-transparent black)
    "-1",               // Bold
    "0",                // Italic
    "0",                // Underline
    "0",                // StrikeOut
    "100",              // ScaleX
    "100",              // ScaleY
    "0",                // Spacing
    "0",                // Angle
    "1",                // BorderStyle (outline + shadow)
    "4",                // Outline thickness
    "2",                // Shadow depth
    "2",                // Alignment (bottom-center)
    "20",               // MarginL
    "20",               // MarginR
    "130",              // MarginV (from bottom)
    "1",                // Encoding
  ].join(",");

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${styleLine}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogues,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fallback: SRT → ASS conversion (used when word timestamps are unavailable)
// ---------------------------------------------------------------------------

function srtTimeToAss(srtTime: string): string {
  const m = srtTime.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return "0:00:00.00";
  return `${parseInt(m[1])}:${m[2]}:${m[3]}.${m[4].slice(0, 2)}`;
}

function srtToAss(srt: string, fontSize: number): string {
  const blocks = srt.trim().split(/\r?\n\r?\n+/);
  const dialogues: string[] = [];

  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 3) continue;

    const timeMatch = lines[1]?.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!timeMatch) continue;

    const start = srtTimeToAss(timeMatch[1]);
    const end = srtTimeToAss(timeMatch[2]);
    const text = lines.slice(2).join("\\N");

    dialogues.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
  }

  const styleLine = [
    "Default", "Arial", String(fontSize),
    "&H00FFFFFF", "&H000000FF", "&H00000000", "&H80000000",
    "-1", "0", "0", "0",
    "100", "100", "0", "0",
    "1", "4", "2",
    "2", "20", "20", "130", "1",
  ].join(",");

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${styleLine}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogues,
    "",
  ].join("\n");
}

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
}): Promise<{ hasSubtitles: boolean; subtitlePath: string; isKaraoke: boolean }> {
  const { uploadFilePath, jobId, index, start, durationForClip, subtitleFontSize } = params;
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

    // Try word-level transcription first (karaoke)
    try {
      const words = await transcribeWords(tempAudioPath);
      if (words.length > 0) {
        const ass = wordsToKaraokeAss(words, subtitleFontSize);
        await fs.writeFile(subtitlePath, ass, "utf-8");
        await fs.rm(tempAudioPath, { force: true });
        return { hasSubtitles: true, subtitlePath, isKaraoke: true };
      }
    } catch {
      // Word-level failed, fall back to SRT-based
    }

    // Fallback: SRT-based subtitles
    const srt = await transcribeToSrt(tempAudioPath);
    const ass = srtToAss(srt, subtitleFontSize);
    await fs.writeFile(subtitlePath, ass, "utf-8");
    await fs.rm(tempAudioPath, { force: true });

    return { hasSubtitles: true, subtitlePath, isKaraoke: false };
  } catch {
    return { hasSubtitles: false, subtitlePath, isKaraoke: false };
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function processVideo(input: PipelineInput): Promise<PipelineResult> {
  const jobId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  await ensureStorageFolders();

  const extension =
    path.extname(input.file.name).toLowerCase().replace(/[^a-z0-9.]/g, "") || ".mp4";
  const uploadFilePath = path.join(uploadDir, `${jobId}${extension}`);
  const data = Buffer.from(await input.file.arrayBuffer());
  await fs.writeFile(uploadFilePath, data);
  const fullAudioPath = path.join(tempDir, `${jobId}_full.mp3`);

  try {
    const duration = await getMediaDurationSeconds(uploadFilePath);
    let starts = buildStarts(duration, input.clipCount, input.clipDuration);
    let scoreMap = new Map<number, ScoreInfo>();

    const fallbackTitle = input.title.trim() || "Clip viral";
    const safeWatermark = ensureTextForDrawText(input.watermark.trim() || "@viralclips");

    let transcriptSegmentsCount = 0;
    let sceneChanges: number[] = [];
    let usedLlmRerank = false;
    let usedSentenceSnap = false;
    let autoTitlesGenerated = 0;
    const diagnostics: string[] = [];

    // Full-video word timestamps for sentence-boundary snapping
    let fullVideoWords: TranscriptWord[] = [];

    // Detect if video is landscape for split-screen
    let isLandscape = false;
    let srcWidth = 0;
    let srcHeight = 0;
    if (input.splitScreen) {
      try {
        const dims = await getMediaDimensions(uploadFilePath);
        srcWidth = dims.width;
        srcHeight = dims.height;
        isLandscape = dims.width > dims.height;
      } catch {
        diagnostics.push("No se pudieron leer las dimensiones del video; split-screen desactivado.");
      }
    }
    const applySplitScreen = input.splitScreen && isLandscape && srcWidth > 0;

    // Extract compressed audio once — used for full-video transcription
    // Whisper API has a 25MB limit; this reduces multi-GB videos to a few MB.
    let fullAudioExtracted = false;
    if (input.smartMode && canTranscribe()) {
      try {
        await extractCompressedAudio(uploadFilePath, fullAudioPath);
        fullAudioExtracted = true;
      } catch {
        diagnostics.push("No se pudo extraer el audio del video para transcripcion.");
      }
    }

    if (input.smartMode) {
      let transcriptSegments = [] as Awaited<ReturnType<typeof transcribeVerbose>>["segments"];

      if (canTranscribe() && fullAudioExtracted) {
        try {
          const verboseResult = await transcribeVerbose(fullAudioPath);
          transcriptSegments = verboseResult.segments;
          transcriptSegmentsCount = transcriptSegments.length;
          fullVideoWords = verboseResult.words;
        } catch (error) {
          diagnostics.push(
            error instanceof Error
              ? `Transcripcion avanzada fallida: ${error.message}`
              : "Transcripcion avanzada fallida.",
          );
        }
      }

      try {
        sceneChanges = await detectSceneChangeTimes(uploadFilePath);
      } catch (error) {
        diagnostics.push(
          error instanceof Error
            ? `Deteccion de escenas fallida: ${error.message}`
            : "Deteccion de escenas fallida.",
        );
        sceneChanges = [];
      }

      // Detect ad/sponsor segments to exclude from clip selection
      let adSegments: AdSegment[] = [];
      if (transcriptSegments.length > 0) {
        adSegments = detectAdSegments(transcriptSegments);
        if (adSegments.length > 0) {
          diagnostics.push(
            `Segmentos de publicidad detectados: ${adSegments.length} (excluidos de la seleccion).`,
          );
        }
      }

      if (transcriptSegments.length > 0 || sceneChanges.length > 0) {
        const allCandidates = buildCandidateWindows({
          duration,
          clipDuration: input.clipDuration,
          segments: transcriptSegments,
          sceneChanges,
        });

        // Filter out candidates that overlap with ad segments
        const candidates = adSegments.length > 0
          ? allCandidates.filter(
              (c) => !isWindowInAdSegment(c.start, input.clipDuration, adSegments),
            )
          : allCandidates;

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
    }

    // Apply sentence-boundary snapping if we have word timestamps
    if (fullVideoWords.length > 0) {
      const snappedStarts = starts.map((rawStart) => {
        const rawEnd = rawStart + input.clipDuration;
        const snapped = snapToSentenceBoundary(fullVideoWords, rawStart, rawEnd);
        return snapped.start;
      });

      // Deduplicate: if snapping collapsed multiple starts to the same point,
      // keep the first and revert duplicates to their original positions.
      const minGap = input.clipDuration * 0.8;
      const finalStarts: number[] = [];
      for (let i = 0; i < snappedStarts.length; i++) {
        const candidate = snappedStarts[i];
        const tooClose = finalStarts.some(
          (prev) => Math.abs(prev - candidate) < minGap,
        );
        if (tooClose) {
          // Revert to original start, shifted slightly to avoid exact overlap
          const fallback = starts[i];
          const fallbackTooClose = finalStarts.some(
            (prev) => Math.abs(prev - fallback) < minGap,
          );
          if (!fallbackTooClose) {
            finalStarts.push(fallback);
          }
          // If even the original overlaps, skip this clip entirely
        } else {
          finalStarts.push(candidate);
        }
      }

      starts = finalStarts.length > 0 ? finalStarts : starts;
      usedSentenceSnap = true;
    }

    // Final safety: deduplicate any starts that ended up too close together
    {
      const safeGap = input.clipDuration * 0.5;
      const deduped: number[] = [];
      const sorted = [...starts].sort((a, b) => a - b);
      for (const s of sorted) {
        if (deduped.length === 0 || s - deduped[deduped.length - 1] >= safeGap) {
          deduped.push(s);
        }
      }
      starts = deduped;
    }

    const fontSize = Math.max(16, Math.min(40, input.subtitleSize));

    const clipsData = starts.map((start, i) => ({
      start,
      durationForClip: Math.min(input.clipDuration, Math.max(duration - start, 1)),
      index: i,
    }));

    // Phase 1: Transcribe ALL clips in parallel (I/O-bound API calls)
    const transcriptionResults = await Promise.allSettled(
      clipsData.map(({ start, durationForClip, index }) =>
        transcribeClipAudio({
          uploadFilePath,
          jobId,
          index,
          start,
          durationForClip,
          subtitleFontSize: fontSize,
        }),
      ),
    );

    // Phase 1.5: Auto-generate viral titles per clip (parallel API calls)
    let clipTitles: string[] = [];
    if (input.autoTitle && fullVideoWords.length > 0 && titleClient) {
      const titlePromises = clipsData.map(({ start, durationForClip }) => {
        const transcript = extractClipTranscript(
          fullVideoWords,
          start,
          start + durationForClip,
        );
        return generateViralTitle(transcript);
      });
      const titleResults = await Promise.allSettled(titlePromises);
      clipTitles = titleResults.map((r) =>
        r.status === "fulfilled" && r.value ? r.value : "",
      );
      autoTitlesGenerated = clipTitles.filter((t) => t.length > 0).length;
    }

    // Phase 2: Render clips sequentially (CPU-bound FFmpeg encoding)
    const clipResults: ClipResult[] = [];
    let karaokeCount = 0;

    for (let i = 0; i < clipsData.length; i += 1) {
      const { start, durationForClip } = clipsData[i];
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

      // Resolve per-clip title: auto-generated or manual fallback
      const clipTitle = clipTitles[i] || fallbackTitle;
      const safeTitle = ensureTextForDrawText(clipTitle);

      const fileName = outputFileName(jobId, i);
      const finalPath = path.join(outputDir, fileName);

      if (applySplitScreen) {
        // -----------------------------------------------------------------
        // Split-screen compositing for landscape video
        // Splits the frame into left/right halves, scales each to 1080x960,
        // stacks vertically into 1080x1920, then applies overlays.
        // -----------------------------------------------------------------
        const safeSubPath = hasSubtitles
          ? ensurePathForSubtitlesFilter(subtitlePath)
          : "";

        // FFmpeg filter_complex: semicolons separate independent chains,
        // commas chain filters within a single stream.
        const overlayFilters = [
          `drawbox=x=0:y=h-220:w=iw:h=220:color=black@0.45:t=fill`,
          `drawbox=x=0:y=958:w=iw:h=4:color=white@0.3:t=fill`,
          // Title: white box with dark text (reference clip style)
          `drawtext=text='${safeTitle}':font=Arial:fontcolor=black:fontsize=44:x=(w-text_w)/2:y=60:box=1:boxcolor=white@0.92:boxborderw=18`,
          `drawtext=text='${safeWatermark}':font=Arial:fontcolor=white@0.90:fontsize=34:x=(w-text_w)/2:y=h-th-65`,
        ];
        if (hasSubtitles) {
          overlayFilters.push(`subtitles='${safeSubPath}'`);
        }

        const filterComplex = [
          `[0:v]split[a][b]`,
          `[a]crop=iw/2:ih:0:0,scale=1080:960[left]`,
          `[b]crop=iw/2:ih:iw/2:0,scale=1080:960[right]`,
          `[left][right]vstack,${overlayFilters.join(",")}[out]`,
        ].join(";");

        await runFfmpeg([
          "-y",
          "-ss", start.toFixed(2),
          "-t", durationForClip.toFixed(2),
          "-i", uploadFilePath,
          "-filter_complex", filterComplex,
          "-map", "[out]",
          "-map", "0:a?",
          "-c:v", "libx264",
          "-preset", clipVideoPreset,
          "-crf", clipVideoCrf,
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", clipAudioBitrate,
          "-movflags", "+faststart",
          finalPath,
        ]);
      } else {
        // -----------------------------------------------------------------
        // Standard vertical crop (1080x1920)
        // -----------------------------------------------------------------
        const filters: string[] = [
          // Bottom bar for watermark readability
          `drawbox=x=0:y=h-220:w=iw:h=220:color=black@0.45:t=fill`,
        ];

        if (hasSubtitles) {
          const safeSubPath = ensurePathForSubtitlesFilter(subtitlePath);
          filters.push(`subtitles='${safeSubPath}'`);
        }

        // Title: white box with dark text (reference clip style)
        filters.push(
          `drawtext=text='${safeTitle}':font=Arial:fontcolor=black:fontsize=44:x=(w-text_w)/2:y=60:box=1:boxcolor=white@0.92:boxborderw=18`,
        );
        filters.push(
          `drawtext=text='${safeWatermark}':font=Arial:fontcolor=white@0.90:fontsize=34:x=(w-text_w)/2:y=h-th-65`,
        );

        await runFfmpeg([
          "-y",
          "-ss", start.toFixed(2),
          "-t", durationForClip.toFixed(2),
          "-i", uploadFilePath,
          "-vf",
          `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${filters.join(",")}`,
          "-c:v", "libx264",
          "-preset", clipVideoPreset,
          "-crf", clipVideoCrf,
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-b:a", clipAudioBitrate,
          "-movflags", "+faststart",
          finalPath,
        ]);
      }

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
        rationale: scoreMap.get(Number(start.toFixed(2)))?.rationale ?? "corte uniforme",
        title: clipTitle,
      });
    }

    const subtitleCount = clipResults.filter((c) => c.hasSubtitles).length;

    return {
      jobId: sanitizeName(jobId),
      clips: clipResults,
      notes: [
        canTranscribe()
          ? subtitleCount > 0
            ? `Subtitulos generados con OpenAI en ${subtitleCount}/${clipResults.length} clips.`
            : "OpenAI disponible pero sin subtitulos generados en este lote."
          : "Sin OPENAI_API_KEY: clips generados con titulo y marca de agua.",
        karaokeCount > 0
          ? `Subtitulos karaoke (word-by-word) en ${karaokeCount}/${subtitleCount} clips.`
          : "Subtitulos karaoke no disponibles (sin timestamps de palabra).",
        input.smartMode && (transcriptSegmentsCount > 0 || sceneChanges.length > 0)
          ? "Modo inteligente activo: score narrativo + deteccion de cambios de escena."
          : "Modo inteligente no disponible: seleccion por distribucion temporal.",
        usedLlmRerank
          ? "Re-ranking final con LLM aplicado."
          : "Re-ranking LLM no aplicado; seleccion heuristica.",
        usedSentenceSnap
          ? "Cortes ajustados a limites de frase (sentence-boundary snapping)."
          : "Sin ajuste de limites de frase.",
        input.autoTitle
          ? autoTitlesGenerated > 0
            ? `Titulos virales auto-generados en ${autoTitlesGenerated}/${clipResults.length} clips.`
            : "Auto-titulo solicitado pero sin transcripcion disponible para generar."
          : "Titulo manual aplicado a todos los clips.",
        applySplitScreen
          ? `Split-screen activado (${srcWidth}x${srcHeight} → dos vistas apiladas).`
          : input.splitScreen
            ? "Split-screen solicitado pero el video no es landscape; usando crop estandar."
            : "Split-screen desactivado.",
        `Render: preset=${clipVideoPreset} crf=${clipVideoCrf} audio=${clipAudioBitrate}.`,
        sceneChanges.length > 0
          ? `Cambios de escena detectados: ${sceneChanges.length}.`
          : "Sin cambios de escena detectados.",
        ...diagnostics,
        "Formato de salida: vertical 1080x1920.",
      ],
    };
  } finally {
    await Promise.all([
      fs.rm(uploadFilePath, { force: true }),
      fs.rm(fullAudioPath, { force: true }),
    ]);
  }
}
