import OpenAI from "openai";
import { runFfprobe } from "@/lib/ffmpeg";
import type { TranscriptSegment } from "@/lib/transcription";

export type CandidateWindow = {
  start: number;
  score: number;
  rationale: string;
  transcriptPreview: string;
  sceneHits: number;
};

const rerankClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const hookWords = [
  // Retention triggers
  "mira", "escucha", "atento", "espera", "ojo", "cuidado",
  // Superlatives / Intensity
  "increible", "brutal", "epico", "tremendo", "bestia", "genial", "alucinante",
  // Conflict / Surprise
  "nunca", "nadie", "jamas", "imposible", "sorpresa", "giro", "impactante",
  // Curiosity triggers
  "secreto", "lo que paso", "la verdad", "no sabian", "resulta que", "imagina",
  // Emotion / Humor
  "locura", "gracioso", "error", "falla", "vergüenza", "ridículo",
  // Viral markers
  "viral", "momento", "esto es", "se volvio", "no puedo", "te juro",
  // English hooks (mixed content)
  "look", "wait", "never", "suddenly", "literally", "actually", "insane",
  "crazy", "wild", "watch", "but then", "right here",
];

// ---------------------------------------------------------------------------
// Ad / sponsor detection
// ---------------------------------------------------------------------------
// Scans transcript segments for common ad markers in Spanish and English.
// Returns time ranges that should be avoided when selecting clip windows.
// ---------------------------------------------------------------------------

const adMarkers = [
  // Spanish
  "patrocinado", "patrocina", "sponsor", "sponsoreado",
  "codigo de descuento", "cupon", "link en la descripcion",
  "link en la bio", "usa mi codigo", "con mi codigo",
  "te dejo el link", "descarga la app", "descarga gratis",
  "suscribete", "dale like", "activa la campana",
  "compra aqui", "aprovecha la oferta", "oferta especial",
  "prueba gratis", "registrate", "entra a",
  // English
  "sponsored by", "use my code", "promo code", "discount code",
  "check the link", "link in the description", "link in bio",
  "download the app", "free trial", "sign up",
  "brought to you by", "thanks to", "shout out to",
];

export type AdSegment = {
  start: number;
  end: number;
};

export function detectAdSegments(
  segments: TranscriptSegment[],
  bufferSeconds = 3,
): AdSegment[] {
  const adRanges: AdSegment[] = [];

  for (const seg of segments) {
    const lower = seg.text.toLowerCase();
    const isAd = adMarkers.some((marker) => lower.includes(marker));
    if (!isAd) continue;

    // Extend the ad range by bufferSeconds on each side to capture the full promo block
    const start = Math.max(0, seg.start - bufferSeconds);
    const end = seg.end + bufferSeconds;

    // Merge with previous range if overlapping
    const last = adRanges[adRanges.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      adRanges.push({ start, end });
    }
  }

  return adRanges;
}

export function isWindowInAdSegment(
  windowStart: number,
  clipDuration: number,
  adSegments: AdSegment[],
  overlapThreshold = 0.3,
): boolean {
  const windowEnd = windowStart + clipDuration;
  for (const ad of adSegments) {
    const overlapStart = Math.max(windowStart, ad.start);
    const overlapEnd = Math.min(windowEnd, ad.end);
    const overlap = Math.max(0, overlapEnd - overlapStart);
    if (overlap / clipDuration >= overlapThreshold) return true;
  }
  return false;
}

function normalizePathForMovieFilter(filePath: string) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function wordCount(text: string) {
  const cleaned = text.trim();
  if (!cleaned) {
    return 0;
  }
  return cleaned.split(/\s+/).length;
}

function hookCount(text: string) {
  const lower = text.toLowerCase();
  return hookWords.reduce((acc, item) => acc + (lower.includes(item) ? 1 : 0), 0);
}

export async function detectSceneChangeTimes(
  videoPath: string,
  durationSeconds?: number,
): Promise<number[]> {
  try {
    // For long videos (>10 min), raise threshold to reduce noise and speed up analysis.
    // Also use a lower framerate analysis to avoid decoding every frame.
    const isLong = (durationSeconds ?? 0) > 600;
    const threshold = isLong ? 0.42 : 0.34;

    const moviePath = normalizePathForMovieFilter(videoPath);
    const filter = `movie='${moviePath}',select=gt(scene\\,${threshold})`;

    const args = [
      "-hide_banner",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      filter,
      "-show_entries",
      "frame=pts_time",
      "-of",
      "csv=p=0",
    ];

    // For very long videos, add a read duration limit to avoid 15+ min analysis
    if ((durationSeconds ?? 0) > 1800) {
      // Analyze only the first 30 minutes for videos > 30 min
      args.splice(4, 0, "-t", "1800");
    }

    const output = await runFfprobe(args);

    const values = output
      .split(/\r?\n/)
      .map((line) => Number(line.split(",")[0].trim()))
      .filter((value) => Number.isFinite(value) && value >= 0);

    return values;
  } catch {
    return [];
  }
}

function scoreWindow(params: {
  start: number;
  clipDuration: number;
  segments: TranscriptSegment[];
  sceneChanges: number[];
}) {
  const { start, clipDuration, segments, sceneChanges } = params;
  const end = start + clipDuration;
  const inside = segments.filter((segment) => segment.end > start && segment.start < end);
  const text = inside.map((segment) => segment.text).join(" ").trim();

  const words = wordCount(text);
  const speechSeconds = inside.reduce((acc, segment) => {
    const segStart = Math.max(start, segment.start);
    const segEnd = Math.min(end, segment.end);
    return acc + Math.max(0, segEnd - segStart);
  }, 0);

  const speechCoverage = speechSeconds / Math.max(clipDuration, 1);
  const density = words / Math.max(clipDuration, 1);
  const punctuation =
    ((text.match(/[!?]/g) ?? []).length + (text.match(/\.{3}/g) ?? []).length) *
    0.6;
  const hooks = hookCount(text);
  const hooksBoost = hooks * 2.2;
  const avgNoSpeechProb =
    inside.length > 0
      ? inside.reduce((acc, segment) => acc + (segment.noSpeechProb ?? 0.3), 0) /
        inside.length
      : 0.6;

  const sceneHits = sceneChanges.filter((time) => time >= start && time <= end).length;
  const sceneBoost = Math.min(sceneHits, 3) * 1.2;

  const firstSegment = inside[0];
  const lastSegment = inside[inside.length - 1];
  const startsMidSentence =
    Boolean(firstSegment) &&
    firstSegment.start < start + 0.35 &&
    firstSegment.text.length > 0 &&
    !/^[A-Z0-9"'¿¡]/.test(firstSegment.text.trim());
  const endsMidSentence =
    Boolean(lastSegment) &&
    lastSegment.end > end - 0.35 &&
    lastSegment.text.length > 0 &&
    !/[.!?…]$/.test(lastSegment.text.trim());

  const openingText = inside
    .filter((segment) => segment.start <= start + 2.7)
    .map((segment) => segment.text)
    .join(" ");
  const openingHookBoost =
    hookCount(openingText) * 0.95 + ((openingText.match(/[!?]/g) ?? []).length > 0 ? 0.8 : 0);

  const boundaryPenalty =
    (startsMidSentence ? 1.9 : 0) + (endsMidSentence ? 1.9 : 0);

  const score =
    density * 5.4 +
    speechCoverage * 6.2 +
    punctuation +
    hooksBoost +
    sceneBoost -
    avgNoSpeechProb * 3.0 +
    openingHookBoost -
    boundaryPenalty;

  const preview = text.length > 220 ? `${text.slice(0, 220)}...` : text;

  return {
    score,
    sceneHits,
    transcriptPreview: preview,
    rationale: `densidad ${density.toFixed(2)} · cobertura ${speechCoverage.toFixed(2)} · hooks ${hooks} · escenas ${sceneHits} · cortes ${boundaryPenalty > 0 ? "abruptos" : "limpios"}`,
  };
}

export function buildCandidateWindows(params: {
  duration: number;
  clipDuration: number;
  segments: TranscriptSegment[];
  sceneChanges: number[];
}) {
  const { duration, clipDuration, segments, sceneChanges } = params;
  const maxStart = Math.max(0, duration - clipDuration);
  const stride = Math.max(2, Math.floor(clipDuration * 0.3));
  const starts = new Set<number>();

  for (let start = 0; start <= maxStart + 0.01; start += stride) {
    starts.add(Number(start.toFixed(2)));
  }

  sceneChanges.forEach((sceneTime) => {
    const candidates = [
      sceneTime - clipDuration * 0.45,
      sceneTime - clipDuration * 0.15,
      sceneTime,
    ];

    candidates.forEach((value) => {
      const normalized = Math.min(maxStart, Math.max(0, value));
      starts.add(Number(normalized.toFixed(2)));
    });
  });

  const windows: CandidateWindow[] = Array.from(starts).map((start) => {
    const scored = scoreWindow({
      start,
      clipDuration,
      segments,
      sceneChanges,
    });

    return {
      start,
      score: scored.score,
      rationale: scored.rationale,
      transcriptPreview: scored.transcriptPreview,
      sceneHits: scored.sceneHits,
    };
  });

  windows.sort((a, b) => b.score - a.score);
  return windows;
}

export function pickHeuristicWindows(params: {
  candidates: CandidateWindow[];
  clipCount: number;
  clipDuration: number;
}) {
  const { candidates, clipCount, clipDuration } = params;
  const selected: CandidateWindow[] = [];
  const minGap = clipDuration * 0.42;

  for (const candidate of candidates) {
    if (selected.length >= clipCount) {
      break;
    }

    const collides = selected.some(
      (item) => Math.abs(item.start - candidate.start) < minGap,
    );

    if (!collides) {
      selected.push(candidate);
    }
  }

  selected.sort((a, b) => a.start - b.start);
  return selected;
}

export async function rerankWithLlm(params: {
  candidates: CandidateWindow[];
  clipCount: number;
  clipDuration: number;
}) {
  if (!rerankClient) {
    return null;
  }

  const { candidates, clipCount, clipDuration } = params;
  if (candidates.length === 0) {
    return null;
  }

  const shortlist = candidates.slice(0, 20).map((candidate, index) => ({
    id: index + 1,
    start: Number(candidate.start.toFixed(2)),
    heuristicScore: Number(candidate.score.toFixed(2)),
    rationale: candidate.rationale,
    preview: candidate.transcriptPreview,
  }));

  const prompt = [
    "Eres un editor experto en contenido viral para YouTube Shorts, TikTok e Instagram Reels.",
    `Selecciona exactamente ${clipCount} clips de ${clipDuration}s con MAXIMO potencial de retencion.`,
    "",
    "CRITERIOS DE SELECCION (en orden de importancia):",
    "1. HOOK INICIAL (40%): Los primeros 3 segundos detienen el scroll? Busca sorpresa, humor, tension, drama o una revelacion.",
    "2. ARCO DE RETENCION (30%): El clip genera curiosidad que recompensa al espectador que se queda hasta el final?",
    "3. ENERGIA Y DENSIDAD (20%): Alta densidad de palabras, emocion clara, ritmo dinamico.",
    "4. CORTES LIMPIOS (10%): Comienza en el inicio de una frase, termina en una pausa natural.",
    "",
    `REGLA OBLIGATORIA: Cada clip DEBE estar separado por al menos ${clipDuration}s del siguiente. NO repitas el mismo momento.`,
    "",
    "PENALIZA FUERTEMENTE: inicios a mitad de oracion, silencios prolongados, contenido repetitivo o sin carga emocional.",
    "PRIORIZA: momentos graciosos, giros inesperados, revelaciones, reacciones extremas, momentos de maxima tension.",
    "",
    `Devuelve UNICAMENTE JSON valido con exactamente ${clipCount} elementos, sin texto adicional:`,
    '{"selected":[{"start":12.3,"score":95,"rationale":"hook en primeros 2s + tension narrativa sostenida"}]}',
    "",
    `Candidatos: ${JSON.stringify(shortlist)}`,
  ].join("\n");

  try {
    const response = await rerankClient.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.15,
      messages: [
        {
          role: "system",
          content:
            "Eres un editor experto en videos virales. Respondes SOLO con JSON valido, sin markdown ni texto adicional.",
        },
        { role: "user", content: prompt },
      ],
    });

    const content = response.choices[0]?.message?.content ?? "";
    const startJson = content.indexOf("{");
    const endJson = content.lastIndexOf("}");
    if (startJson < 0 || endJson <= startJson) {
      return null;
    }

    const parsed = JSON.parse(content.slice(startJson, endJson + 1)) as {
      selected?: Array<{ start?: number; score?: number; rationale?: string }>;
    };

    const selected = (parsed.selected ?? [])
      .map((item) => ({
        start: Number(item.start),
        score: Number(item.score ?? 0),
        rationale: String(item.rationale ?? "re-ranking llm"),
      }))
      .filter((item) => Number.isFinite(item.start));

    if (selected.length === 0) {
      return null;
    }

    // Map LLM picks back to actual candidates, enforcing minimum gap
    const minGap = clipDuration * 0.8;
    const mapped: CandidateWindow[] = [];
    const usedStarts = new Set<number>();

    for (const item of selected.slice(0, clipCount * 2)) {
      if (mapped.length >= clipCount) break;

      const nearest = candidates.reduce((best, candidate) => {
        if (!best) return candidate;
        const d1 = Math.abs(candidate.start - item.start);
        const d2 = Math.abs(best.start - item.start);
        return d1 < d2 ? candidate : best;
      }, null as CandidateWindow | null);

      if (!nearest) continue;

      // Skip if this candidate was already used or too close to a previous pick
      if (usedStarts.has(nearest.start)) continue;
      const tooClose = mapped.some(
        (prev) => Math.abs(prev.start - nearest.start) < minGap,
      );
      if (tooClose) continue;

      usedStarts.add(nearest.start);
      mapped.push({
        ...nearest,
        score: Number(item.score.toFixed(2)),
        rationale: item.rationale,
      });
    }

    return mapped.length > 0 ? mapped : null;
  } catch {
    return null;
  }
}
