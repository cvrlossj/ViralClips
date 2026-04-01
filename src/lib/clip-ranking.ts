import OpenAI from "openai";
import { runFfprobe } from "@/lib/ffmpeg";
import type { TranscriptSegment } from "@/lib/transcription";
import { getAdaptiveScoringProfile } from "@/lib/adaptive-learning";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClipScores = {
  hook: number;       // 0-100: Do the first 3s stop the scroll?
  flow: number;       // 0-100: Does the clip maintain engagement throughout?
  engagement: number; // 0-100: Emotional intensity, humor, surprise
  completeness: number; // 0-100: Does the clip tell a complete micro-story?
};

export type NarrativeBeatName = "setup" | "tension" | "payoff" | "reaction";

export type NarrativeBeatDetail = {
  score: number;
  reasons: string[];
  evidence: string[];
};

export type NarrativeBeatReport = {
  start: number;
  end: number;
  duration: number;
  score: number;
  reasons: string[];
  beats: Record<NarrativeBeatName, NarrativeBeatDetail>;
};

export type PlatformDescriptions = {
  tiktok: string;
  instagram: string;
  youtube: string;
};

export type DetectedMoment = {
  start: number;
  end: number;
  title: string;
  /** Viral hook sentence used for packaging/copywriting */
  hookText: string;
  /** Best second within the clip for zoompan emphasis */
  zoomTimestamp: number | null;
  /** Platform-specific descriptions/captions */
  descriptions: PlatformDescriptions;
  scores: ClipScores;
  overallScore: number;
  rationale: string;
  transcriptPreview: string;
};

// Legacy type — kept for heuristic fallback
export type CandidateWindow = {
  start: number;
  end: number;
  score: number;
  rationale: string;
  transcriptPreview: string;
  sceneHits: number;
};

export type AdSegment = {
  start: number;
  end: number;
};

export type BeatEvent = {
  label: "hook" | "setup" | "buildup" | "payoff" | "reaction";
  timestamp: number;
  score: number;
  reason: string;
};

export type BeatEvaluation = {
  anchorTimestamp: number;
  events: BeatEvent[];
  hookScore: number;
  beatCoverageScore: number;
  completenessScore: number;
  narrativeScore: number;
  engagementScore: number;
  missingBeats: Array<BeatEvent["label"]>;
  flatRisk: boolean;
  summary: string;
};

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------

const llmClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function readDurationEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function readFloatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

const MIN_CLIP_DURATION_TARGET_SEC = readDurationEnv("CLIP_MIN_DURATION_SECONDS", 48, 20, 120);
const SCENE_DETECT_THRESHOLD_SHORT = readFloatEnv("SCENE_DETECT_THRESHOLD_SHORT", 0.39, 0.2, 0.8);
const SCENE_DETECT_THRESHOLD_LONG = readFloatEnv("SCENE_DETECT_THRESHOLD_LONG", 0.47, 0.2, 0.9);
const SCENE_CHANGE_MIN_GAP_SECONDS = readFloatEnv("SCENE_CHANGE_MIN_GAP_SECONDS", 1.35, 0.35, 6);
const SCENE_CHANGE_MAX_PER_MINUTE = readFloatEnv("SCENE_CHANGE_MAX_PER_MINUTE", 18, 4, 80);
const SCENE_BOUNDARY_SNAP_MIN_GAP_SEC = readFloatEnv("SCENE_BOUNDARY_SNAP_MIN_GAP_SEC", 1.1, 0.2, 6);
const SCENE_NEAR_WINDOW_SEC = readFloatEnv("SCENE_NEAR_WINDOW_SEC", 0.9, 0.2, 3);
const VIRAL_HOOK_STYLE = String(process.env.VIRAL_HOOK_STYLE ?? "top3").trim().toLowerCase();

type ViralHookTemplate = "never_do_x" | "i_did_x" | "before_you_do_x";

const hookTopicStopWords = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas",
  "de", "del", "al", "en", "por", "para", "con", "sin", "sobre",
  "que", "y", "o", "u", "a", "e", "se", "te", "me", "mi", "tu", "su",
  "lo", "le", "les", "esto", "esta", "este", "estos", "estas",
  "ya", "muy", "mas", "pero", "porque", "como", "cuando", "donde",
  "then", "this", "that", "with", "from", "your", "you", "the", "and",
]);

function normalizeHookTopic(input: string) {
  const compact = input
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "esto";

  const tokens = compact
    .split(" ")
    .filter((token) => token.length >= 3 && !hookTopicStopWords.has(token));
  if (tokens.length === 0) return "esto";
  return tokens.slice(0, 5).join(" ");
}

function detectHookTemplateHint(text: string): ViralHookTemplate | null {
  const lower = text.toLowerCase();
  if (
    /nunca\s+hagas|no\s+hagas|peor\s+que\s+puedes\s+hacer|error\s+fatal|evita\s+hacer/.test(lower)
  ) {
    return "never_do_x";
  }
  if (/\bhice\b|me\s+paso|intent[eé]|prob[eé]|y\s+esto\s+pas[oó]/.test(lower)) {
    return "i_did_x";
  }
  if (/si\s+vas\s+a\s+hacer|antes\s+de\s+hacer|primero\s+mira\s+este\s+video/.test(lower)) {
    return "before_you_do_x";
  }
  return null;
}

function chooseViralHookTemplate(text: string): ViralHookTemplate {
  const hinted = detectHookTemplateHint(text);
  if (hinted) return hinted;

  const lower = text.toLowerCase();
  let neverScore = 0;
  let didScore = 0;
  let beforeScore = 0;

  if (/nunca|jam[aá]s|cuidado|riesgo|error|peor|arruina|prohibido/.test(lower)) neverScore += 3;
  if (/\bhice\b|me\s+pas[oó]|intent[eé]|prob[eé]|grab[eé]|fu[ií]/.test(lower)) didScore += 3;
  if (/si\s+vas\s+a|antes\s+de|primero|mira\s+esto|te\s+conviene/.test(lower)) beforeScore += 3;

  if (/\bno\b/.test(lower)) neverScore += 1;
  if (/\byo\b|\bmi\b|\bme\b/.test(lower)) didScore += 1;
  if (/\bsi\b|\bprimero\b/.test(lower)) beforeScore += 1;

  const maxScore = Math.max(neverScore, didScore, beforeScore);
  const tied: ViralHookTemplate[] = [];
  if (neverScore === maxScore) tied.push("never_do_x");
  if (didScore === maxScore) tied.push("i_did_x");
  if (beforeScore === maxScore) tied.push("before_you_do_x");

  if (tied.length === 1) return tied[0];
  const tieBreaker = Math.abs(text.length) % tied.length;
  return tied[tieBreaker] ?? "before_you_do_x";
}

function buildTopViralHook(text: string, preferredTemplate?: ViralHookTemplate | null) {
  const topic = normalizeHookTopic(text);
  const template = preferredTemplate ?? chooseViralHookTemplate(text);

  switch (template) {
    case "never_do_x":
      return `Nunca hagas ${topic} porque es lo peor que puedes hacer`;
    case "i_did_x":
      return `Hice ${topic} y esto paso`;
    case "before_you_do_x":
    default:
      return `Si vas a hacer ${topic}, primero mira este video`;
  }
}

function normalizeHookText(rawHookText: string, contextText: string) {
  const candidate = rawHookText
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = candidate.slice(0, 140);

  if (VIRAL_HOOK_STYLE === "legacy") {
    return clipped ? clipped.toUpperCase().slice(0, 40) : "";
  }

  const matchedTemplate = detectHookTemplateHint(clipped);
  if (matchedTemplate) {
    return buildTopViralHook(`${clipped} ${contextText}`.trim(), matchedTemplate);
  }

  const source = `${clipped} ${contextText}`.trim();
  if (!source) return "";
  return buildTopViralHook(source);
}

// ---------------------------------------------------------------------------
// Ad / sponsor detection
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

export function detectAdSegments(
  segments: TranscriptSegment[],
  bufferSeconds = 3,
): AdSegment[] {
  const adRanges: AdSegment[] = [];

  for (const seg of segments) {
    const lower = seg.text.toLowerCase();
    const isAd = adMarkers.some((marker) => lower.includes(marker));
    if (!isAd) continue;

    const start = Math.max(0, seg.start - bufferSeconds);
    const end = seg.end + bufferSeconds;

    const last = adRanges[adRanges.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      adRanges.push({ start, end });
    }
  }

  return adRanges;
}

// ---------------------------------------------------------------------------
// Scene change detection
// ---------------------------------------------------------------------------

function normalizePathForMovieFilter(filePath: string) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function filterSceneChangesByGap(values: number[], minGapSeconds: number): number[] {
  const ordered = [...values].sort((a, b) => a - b);
  if (ordered.length <= 1) return ordered;

  const filtered: number[] = [ordered[0]];
  let last = ordered[0];

  for (let i = 1; i < ordered.length; i += 1) {
    const current = ordered[i];
    if (current - last >= minGapSeconds) {
      filtered.push(current);
      last = current;
    }
  }

  return filtered;
}

function smoothSceneChanges(rawSceneChanges: number[], durationSeconds?: number): number[] {
  const cleaned = rawSceneChanges
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (cleaned.length <= 1) return cleaned.map((value) => round2(value));

  const videoDuration = Math.max(
    1,
    Number.isFinite(durationSeconds) && (durationSeconds ?? 0) > 0
      ? Number(durationSeconds)
      : cleaned[cleaned.length - 1],
  );
  const maxChanges = Math.max(8, Math.round((videoDuration / 60) * SCENE_CHANGE_MAX_PER_MINUTE));

  let minGap = SCENE_CHANGE_MIN_GAP_SECONDS;
  let filtered = filterSceneChangesByGap(cleaned, minGap);

  let guard = 0;
  while (filtered.length > maxChanges && guard < 8) {
    minGap *= 1.2;
    filtered = filterSceneChangesByGap(cleaned, minGap);
    guard += 1;
  }

  if (filtered.length > maxChanges) {
    const step = Math.ceil(filtered.length / maxChanges);
    filtered = filtered.filter((_value, index) => index % step === 0);
  }

  return filtered.map((value) => round2(value));
}

export async function detectSceneChangeTimes(
  videoPath: string,
  durationSeconds?: number,
): Promise<number[]> {
  try {
    const isLong = (durationSeconds ?? 0) > 600;
    const threshold = isLong ? SCENE_DETECT_THRESHOLD_LONG : SCENE_DETECT_THRESHOLD_SHORT;

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

    if ((durationSeconds ?? 0) > 1800) {
      args.splice(4, 0, "-t", "1800");
    }

    const output = await runFfprobe(args);

    const rawSceneChanges = output
      .split(/\r?\n/)
      .map((line) => Number(line.split(",")[0].trim()))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return smoothSceneChanges(rawSceneChanges, durationSeconds);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM-first moment detection (the core improvement)
// ---------------------------------------------------------------------------
// Instead of sliding a fixed-size window, we send the full timestamped
// transcript to GPT-4o and ask it to identify the best viral moments
// with their natural start/end times. The LLM understands context,
// humor, story arcs, and knows where moments naturally begin and end.
// ---------------------------------------------------------------------------

function buildTimestampedTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `[${formatTimecode(s.start)} - ${formatTimecode(s.end)}] ${s.text}`)
    .join("\n");
}

function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export async function detectMomentsWithLlm(params: {
  segments: TranscriptSegment[];
  sceneChanges: number[];
  adSegments: AdSegment[];
  videoDuration: number;
  maxClips: number;
  visualContext?: string;
  /** Real TikTok benchmark data to calibrate scoring */
  benchmarkContext?: string;
}): Promise<DetectedMoment[] | null> {
  if (!llmClient) return null;

  const { segments, sceneChanges, adSegments, videoDuration, maxClips, visualContext, benchmarkContext } = params;
  const profile = getAdaptiveScoringProfile();
  const clipWeights = profile.weights.clipOverall;
  if (segments.length === 0) return null;

  const transcript = buildTimestampedTranscript(segments);

  // Build ad ranges string for the prompt
  const adRangesStr = adSegments.length > 0
    ? `\n\nZONAS DE PUBLICIDAD (EVITAR): ${adSegments.map((a) => `${formatTimecode(a.start)}-${formatTimecode(a.end)}`).join(", ")}`
    : "";

  // Build scene changes hint
  const sceneStr = sceneChanges.length > 0
    ? `\n\nCAMBIOS DE ESCENA DETECTADOS EN: ${sceneChanges.slice(0, 50).map((t) => formatTimecode(t)).join(", ")}`
    : "";

  // Visual analysis context (from GPT-4o Vision keyframe analysis)
  const visualStr = visualContext
    ? `\n\n${visualContext}`
    : "";

  // Real TikTok benchmark data (from TikTok Scraper7 API)
  const benchmarkStr = benchmarkContext
    ? `\n\n${benchmarkContext}`
    : "";

  const prompt = `Eres un editor experto en contenido viral para YouTube Shorts, TikTok e Instagram Reels.

TRANSCRIPCION COMPLETA CON TIMESTAMPS:
${transcript}

DURACION TOTAL DEL VIDEO: ${formatTimecode(videoDuration)}${adRangesStr}${sceneStr}${visualStr}${benchmarkStr}

TU TAREA: Identifica hasta ${maxClips} momentos VIRALES del video. Cada momento debe ser un clip auto-contenido con DURACION VARIABLE (minimo ${MIN_CLIP_DURATION_TARGET_SEC} segundos, maximo 180 segundos).

REGLAS CRITICAS:
1. Cada clip debe tener un INICIO NATURAL (inicio de frase, momento de atencion) y un FINAL NATURAL (fin de una idea, remate, reaccion).
2. NO cortes a mitad de una oracion o momento. El clip debe sentirse COMPLETO.
3. La duracion la determina el CONTENIDO, no un numero fijo. PRIORIDAD: no entregar clips cortos. Si el momento clave es breve, extiende hacia atras (setup) y hacia adelante (reaccion) para llegar minimo ${MIN_CLIP_DURATION_TARGET_SEC}s.
4. Los clips NO deben solaparse. Deja al menos 5 segundos entre clips.
5. EVITA las zonas de publicidad marcadas.
6. Prioriza: momentos graciosos, giros inesperados, revelaciones, reacciones extremas, conflictos, tension maxima.
7. COMBINA el analisis de audio (transcripcion) con el analisis VISUAL. Los mejores clips tienen AMBOS: dialogo interesante + accion visual intensa.
8. Si hay zonas visualmente intensas, PRIORIZA clips que las incluyan. Un momento con reacciones faciales extremas + dialogo gracioso = clip viral garantizado.

⚠️ REGLA CRITICA DE CONTEXTO — MUY IMPORTANTE:
9. NUNCA empieces un clip en el momento exacto de la risa, reaccion o punchline. SIEMPRE incluye el SETUP/CONTEXTO ANTES del momento clave. El espectador necesita entender POR QUE es gracioso/impactante.
   - MAL: Clip empieza cuando alguien ya se esta riendo → el espectador no entiende nada
   - BIEN: Clip empieza 5-15 segundos ANTES, cuando se plantea la situacion → el espectador entiende el contexto y cuando llega la risa/reaccion, el impacto es 10x mayor
   - Piensa como un COMEDIANTE: setup → buildup → punchline → reaccion. El clip DEBE incluir las 4 fases.
   - Si hay una historia/anecdota, incluye el INICIO de la anecdota, no solo el final.
   - Si hay una broma, incluye la PREGUNTA o situacion que genera la broma.
   - El clip ideal: el espectador entiende la situacion en los primeros 5s, se engancha, y el payoff llega despues.
10. Varia los TIPOS de clips. No selecciones solo momentos de risa. Incluye: momentos de tension, revelaciones, historias emotivas, confrontaciones, opiniones polemicas, momentos WTF, fails, reacciones genuinas.
11. El "hookText" debe usar UNA de estas formulas virales (adaptada al contexto real del clip):
   - Nunca hagas (x) porque es lo peor que puedes hacer
   - Hice (x) y esto paso
   - Si vas a hacer (x) primero mira este video

SCORING (0-100 cada uno):
- hook: Los primeros 3 segundos del clip detienen el scroll? Hay una frase gancho, sorpresa, o tension inmediata? BONUS si hay accion visual inmediata.
- flow: El ritmo se mantiene durante todo el clip? Hay dinamismo, sin silencios muertos? Considerar variedad visual.
- engagement: Hay emocion fuerte? Humor, drama, sorpresa, tension? El espectador siente algo? Considerar reacciones faciales visibles.
- completeness: El clip cuenta una micro-historia COMPLETA con CONTEXTO? Tiene setup, buildup, payoff y reaccion? PENALIZA clips que empiezan en el punchline sin contexto.

PARA CADA MOMENTO GENERA:
- title: Titulo viral corto (6-8 palabras, sin emojis/hashtags)
- hookText: Frase de gancho viral (8-18 palabras) usando SOLO una de las 3 formulas indicadas arriba y reemplazando (x) por el tema real del clip.
- zoomTimestamp: El segundo EXACTO dentro del clip donde ocurre el momento mas intenso (para aplicar zoom). Debe ser un timestamp absoluto del video original.
- descriptions: Objeto con 3 descripciones adaptadas a cada plataforma:
  - tiktok: Caption corta y casual con CTA. Ejemplo: "No me esperaba este final... Sigueme para mas 🔥 #viral"
  - instagram: Caption media, profesional, con hashtags. Ejemplo: "Este momento lo cambio todo 🎬 #shorts #viral #clips"
  - youtube: Descripcion para YouTube Shorts, clickbait pero real. Ejemplo: "Nadie se esperaba lo que paso en el segundo 15..."

RESPONDE UNICAMENTE CON JSON VALIDO, SIN MARKDOWN NI TEXTO ADICIONAL:
{"moments":[{"start":12.5,"end":38.2,"title":"Titulo viral corto","hookText":"Si vas a hacer esto primero mira este video","zoomTimestamp":25.3,"descriptions":{"tiktok":"Caption TikTok...","instagram":"Caption Instagram...","youtube":"Caption YouTube..."},"hook":85,"flow":78,"engagement":92,"completeness":80,"rationale":"Por que este momento es viral"}]}

Los timestamps deben ser en SEGUNDOS (decimal).`;

  try {
    const response = await llmClient.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      max_tokens: 4096,
      messages: [
        {
          role: "system",
          content: "Eres un editor experto en videos virales. Analizas transcripciones para encontrar los momentos mas virales. Respondes SOLO con JSON valido.",
        },
        { role: "user", content: prompt },
      ],
    });

    const content = response.choices[0]?.message?.content ?? "";
    const startJson = content.indexOf("{");
    const endJson = content.lastIndexOf("}");
    if (startJson < 0 || endJson <= startJson) return null;

    const parsed = JSON.parse(content.slice(startJson, endJson + 1)) as {
      moments?: Array<{
        start?: number;
        end?: number;
        title?: string;
        hookText?: string;
        zoomTimestamp?: number;
        descriptions?: { tiktok?: string; instagram?: string; youtube?: string };
        hook?: number;
        flow?: number;
        engagement?: number;
        completeness?: number;
        rationale?: string;
      }>;
    };

    const moments = (parsed.moments ?? [])
      .map((m) => {
        const start = Number(m.start);
        const end = Number(m.end);
        const duration = end - start;

        // Validate raw LLM windows first. Short windows can still be expanded later
        // by the narrative-refinement/variant passes in the pipeline.
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        if (duration < 20 || duration > 180) return null;
        if (start < 0 || end > videoDuration + 2) return null;

        const scores: ClipScores = {
          hook: clamp(Number(m.hook ?? 50), 0, 100),
          flow: clamp(Number(m.flow ?? 50), 0, 100),
          engagement: clamp(Number(m.engagement ?? 50), 0, 100),
          completeness: clamp(Number(m.completeness ?? 50), 0, 100),
        };

        // Weighted overall score (matching OpusClip's priorities)
        const overallScore = Math.round(
          scores.hook * clipWeights.hook +
          scores.flow * clipWeights.flow +
          scores.engagement * clipWeights.engagement +
          scores.completeness * clipWeights.completeness,
        );

        // Get transcript preview for this range
        const preview = segments
          .filter((s) => s.end > start && s.start < end)
          .map((s) => s.text)
          .join(" ")
          .trim();

        // Parse zoom timestamp (must be within clip bounds)
        const rawZoom = Number(m.zoomTimestamp);
        const zoomTimestamp = Number.isFinite(rawZoom) && rawZoom >= start && rawZoom <= end
          ? Number(rawZoom.toFixed(2))
          : null;

        // Parse platform descriptions
        const descriptions: PlatformDescriptions = {
          tiktok: String(m.descriptions?.tiktok ?? "").trim().slice(0, 300),
          instagram: String(m.descriptions?.instagram ?? "").trim().slice(0, 300),
          youtube: String(m.descriptions?.youtube ?? "").trim().slice(0, 300),
        };
        const normalizedHookText = normalizeHookText(String(m.hookText ?? ""), preview);

        return {
          start: Number(start.toFixed(2)),
          end: Number(end.toFixed(2)),
          title: String(m.title ?? "").trim().slice(0, 80) || "Clip viral",
          hookText: normalizedHookText,
          zoomTimestamp,
          descriptions,
          scores,
          overallScore,
          rationale: String(m.rationale ?? "").trim(),
          transcriptPreview: preview.length > 300 ? `${preview.slice(0, 300)}...` : preview,
        } satisfies DetectedMoment;
      })
      .filter((m): m is DetectedMoment => m !== null);

    if (moments.length === 0) return null;

    // Remove overlapping moments (keep higher score)
    const deduped = deduplicateMoments(moments);

    // Sort by score descending, then take top maxClips
    deduped.sort((a, b) => b.overallScore - a.overallScore);
    return deduped.slice(0, maxClips);
  } catch {
    return null;
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function deduplicateMoments(moments: DetectedMoment[]): DetectedMoment[] {
  // Sort by score descending
  const sorted = [...moments].sort((a, b) => b.overallScore - a.overallScore);
  const result: DetectedMoment[] = [];

  for (const m of sorted) {
    const overlaps = result.some((existing) => {
      const overlapStart = Math.max(m.start, existing.start);
      const overlapEnd = Math.min(m.end, existing.end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const duration = m.end - m.start;
      return overlap > duration * 0.3; // >30% overlap = duplicate
    });
    if (!overlaps) result.push(m);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Narrative context refinement
// ---------------------------------------------------------------------------
// LLM selection can still cut too close to the punchline. This pass expands
// boundaries to include setup + payoff + reaction using transcript structure.
// ---------------------------------------------------------------------------

type RefineMomentsParams = {
  moments: DetectedMoment[];
  segments: TranscriptSegment[];
  adSegments: AdSegment[];
  sceneChanges: number[];
  videoDuration: number;
  maxClips: number;
};

const NARRATIVE_BEAT_CONFIG: Record<NarrativeBeatName, {
  label: string;
  windowStartRatio: number;
  windowEndRatio: number;
  positionWeight: (position: number) => number;
  cues: string[];
}> = {
  setup: {
    label: "setup",
    windowStartRatio: 0,
    windowEndRatio: 0.38,
    positionWeight: (position) => clamp(1 - position / 0.42, 0, 1),
    cues: [
      "mira",
      "escucha",
      "te cuento",
      "resulta que",
      "cuando",
      "entonces",
      "primero",
      "antes",
      "imagina",
      "la cosa es",
      "el punto es",
      "vamos a ver",
      "here's the thing",
      "story",
      "so ",
      "what happened",
    ],
  },
  tension: {
    label: "tension",
    windowStartRatio: 0.18,
    windowEndRatio: 0.82,
    positionWeight: (position) => clamp(1 - Math.abs(position - 0.5) / 0.28, 0, 1),
    cues: [
      "pero",
      "sin embargo",
      "aunque",
      "ojo",
      "espera",
      "a ver",
      "problema",
      "presion",
      "tension",
      "conflicto",
      "se complica",
      "de repente",
      "hasta que",
      "wait",
      "hold on",
      "but then",
      "however",
      "suddenly",
    ],
  },
  payoff: {
    label: "payoff",
    windowStartRatio: 0.45,
    windowEndRatio: 1,
    positionWeight: (position) => clamp((position - 0.35) / 0.65, 0, 1),
    cues: [
      "al final",
      "finalmente",
      "resulta que",
      "entonces",
      "y ahi",
      "boom",
      "plot twist",
      "no puede ser",
      "increible",
      "brutal",
      "remate",
      "descubre",
      "lo logro",
      "lo hizo",
      "se resuelve",
      "termino",
      "salio bien",
      "salio mal",
    ],
  },
  reaction: {
    label: "reaction",
    windowStartRatio: 0.62,
    windowEndRatio: 1,
    positionWeight: (position) => clamp((position - 0.6) / 0.4, 0, 1),
    cues: [
      "jaja",
      "jeje",
      "lol",
      "wow",
      "omg",
      "wtf",
      "bro",
      "madre mia",
      "nooo",
      "ay dios",
      "me muero",
      "que fuerte",
      "no puede ser",
      "what",
      "oh my god",
      "mira eso",
      "reaccion",
      "risas",
    ],
  },
};

function formatNarrativeEvidence(segment: TranscriptSegment) {
  const text = segment.text.trim().replace(/\s+/g, " ");
  const clippedText = text.length > 96 ? `${text.slice(0, 96)}...` : text;
  return `[${formatTimecode(segment.start)}] ${clippedText}`;
}

function countCueHits(text: string, cues: string[]) {
  const lower = text.toLowerCase();
  return cues.filter((cue) => lower.includes(cue)).length;
}

function findFirstCueMatch(text: string, cues: string[]) {
  const lower = text.toLowerCase();
  return cues.find((cue) => lower.includes(cue)) ?? null;
}

function evaluateNarrativeBeatDetail(params: {
  segments: TranscriptSegment[];
  clipStart: number;
  clipEnd: number;
  beat: NarrativeBeatName;
}): NarrativeBeatDetail {
  const { segments, clipStart, clipEnd, beat } = params;
  const config = NARRATIVE_BEAT_CONFIG[beat];
  const duration = Math.max(clipEnd - clipStart, 0.001);
  const windowStart = clipStart + duration * config.windowStartRatio;
  const windowEnd = clipStart + duration * config.windowEndRatio;
  const windowDuration = Math.max(windowEnd - windowStart, 0.001);

  let coverageSeconds = 0;
  let signalScore = 0;
  let cueHits = 0;
  let speechSegments = 0;
  const evidenceEntries: Array<{ score: number; text: string }> = [];
  const reasons = new Set<string>();

  for (const segment of segments) {
    const overlap = overlapSeconds(windowStart, windowEnd, segment.start, segment.end);
    if (overlap <= 0) continue;

    const text = segment.text.trim();
    if (!text) continue;

    const center = (segment.start + segment.end) / 2;
    const position = (center - clipStart) / duration;
    const positionWeight = config.positionWeight(position);
    if (positionWeight <= 0) continue;

    speechSegments += 1;
    coverageSeconds += overlap;

    const matchedHits = countCueHits(text, config.cues);
    cueHits += matchedHits;

    const punctuationBonus = /[!?]/.test(text) ? 3 : 0;
    const sentenceBonus = SEGMENT_SENTENCE_END_RE.test(text) ? 3 : 0;
    const wordBonus = Math.min(8, Math.max(2, text.split(/\s+/).length / 5));
    const segmentScore = positionWeight * (matchedHits * 14 + punctuationBonus + sentenceBonus + wordBonus);
    signalScore += segmentScore;

    if (matchedHits > 0 || punctuationBonus > 0 || sentenceBonus > 0) {
      evidenceEntries.push({
        score: segmentScore,
        text: formatNarrativeEvidence(segment),
      });
    }

    if (matchedHits > 0) {
      const matchedCue = findFirstCueMatch(text, config.cues);
      if (matchedCue) {
        reasons.add(`${config.label} con "${matchedCue}"`);
      }
    }
  }

  evidenceEntries.sort((a, b) => b.score - a.score);
  const evidence = evidenceEntries.slice(0, 3).map((entry) => entry.text);

  const coverageRatio = coverageSeconds / windowDuration;
  const coverageScore = Math.round(coverageRatio * 28);
  const densityBonus = Math.min(10, speechSegments * 3);
  const signalComponent = Math.min(54, Math.round(signalScore));
  const score = clamp(Math.round(coverageScore + densityBonus + signalComponent), 0, 100);

  if (beat === "setup") {
    if (score >= 70) {
      reasons.add("arranque con contexto claro");
    } else if (score >= 45) {
      reasons.add("setup parcial pero util");
    } else {
      reasons.add("falta contexto de arranque");
    }
  } else if (beat === "tension") {
    if (score >= 70) {
      reasons.add("la presion sube en el centro");
    } else if (score >= 45) {
      reasons.add("hay tension, pero no domina el tramo medio");
    } else {
      reasons.add("la parte media se siente plana");
    }
  } else if (beat === "payoff") {
    if (score >= 70) {
      reasons.add("payoff claro al final");
    } else if (score >= 45) {
      reasons.add("hay remate, pero queda tibio");
    } else {
      reasons.add("falta payoff o resolucion");
    }
  } else {
    if (score >= 70) {
      reasons.add("reaccion visible al cierre");
    } else if (score >= 45) {
      reasons.add("reaccion presente, pero corta");
    } else {
      reasons.add("no hay reaccion final suficiente");
    }
  }

  if (cueHits > 0) {
    reasons.add(`${cueHits} señal${cueHits === 1 ? "" : "es"} narrativa${cueHits === 1 ? "" : "s"}`);
  }

  return {
    score,
    reasons: [...reasons],
    evidence,
  };
}

export function evaluateNarrativeBeatReport(params: {
  segments: TranscriptSegment[];
  start: number;
  end: number;
}): NarrativeBeatReport {
  const start = Number.isFinite(params.start) ? Math.max(0, params.start) : 0;
  const end = Number.isFinite(params.end) ? Math.max(start, params.end) : start;
  const duration = Math.max(0, end - start);

  if (duration <= 0) {
    const emptyBeat: NarrativeBeatDetail = {
      score: 0,
      reasons: ["rango narrativo invalido"],
      evidence: [],
    };

    return {
      start,
      end,
      duration: 0,
      score: 0,
      reasons: ["rango narrativo invalido"],
      beats: {
        setup: emptyBeat,
        tension: emptyBeat,
        payoff: emptyBeat,
        reaction: emptyBeat,
      },
    };
  }

  const orderedSegments = [...params.segments]
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  const beats = {
    setup: evaluateNarrativeBeatDetail({ segments: orderedSegments, clipStart: start, clipEnd: end, beat: "setup" }),
    tension: evaluateNarrativeBeatDetail({ segments: orderedSegments, clipStart: start, clipEnd: end, beat: "tension" }),
    payoff: evaluateNarrativeBeatDetail({ segments: orderedSegments, clipStart: start, clipEnd: end, beat: "payoff" }),
    reaction: evaluateNarrativeBeatDetail({ segments: orderedSegments, clipStart: start, clipEnd: end, beat: "reaction" }),
  };

  const score = clamp(Math.round(
    beats.setup.score * 0.24 +
    beats.tension.score * 0.20 +
    beats.payoff.score * 0.36 +
    beats.reaction.score * 0.20,
  ), 0, 100);

  const reasons: string[] = [
    `setup ${beats.setup.score} · tension ${beats.tension.score} · payoff ${beats.payoff.score} · reaction ${beats.reaction.score}`,
  ];

  if (beats.payoff.score < 45) {
    reasons.push("payoff insuficiente");
  }

  if (beats.setup.score < 45 || beats.reaction.score < 45) {
    reasons.push("falta setup o reaccion");
  }

  if (beats.setup.score >= 55 && beats.payoff.score >= 55 && beats.reaction.score >= 55) {
    reasons.push("arc narrativo completo");
  } else if (beats.tension.score >= 55) {
    reasons.push("hay escalada narrativa");
  }

  return {
    start,
    end,
    duration,
    score,
    reasons,
    beats,
  };
}

const SEGMENT_SENTENCE_END_RE = /[.!?…]["')\]]?\s*$/;
const SEGMENT_SETUP_CUE_RE =
  /\b(mira|te cuento|resulta|cuando|entonces|despues|de repente|imagina|la cosa es|primero|ojo)\b/i;
const SEGMENT_IMPACT_CUE_RE =
  /\b(no puede|increible|brutal|locura|wtf|wow|jaja|plot twist|sorpresa|exploto|viral|insano)\b/i;

const SOFT_GAP_SEC = 0.45;
const HARD_GAP_SEC = 1.2;
const MIN_CONTEXT_DURATION_SEC = MIN_CLIP_DURATION_TARGET_SEC;
const MAX_CONTEXT_DURATION_SEC = 180;
const MAX_LOOKBACK_SEC = 45;
const MAX_LOOKAHEAD_SEC = 42;

function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

const BEAT_SETUP_RE =
  /\b(mira|te cuento|resulta|cuando|entonces|despues|primero|ojo|antes|contexto|imagina)\b/i;
const BEAT_BUILDCUP_RE =
  /\b(pero|aunque|todavia|espera|vamos|de hecho|poco a poco|cada vez|mientras|seguia)\b/i;
const BEAT_PAYOFF_RE =
  /\b(no puede|increible|brutal|locura|wtf|wow|jaja|boom|sorpresa|explot(o|a)|revelo|descubrio|perdio|gano)\b/i;
const BEAT_REACTION_RE =
  /\b(jaja|haha|lol|llora|grita|reacciona|nooo|que|what|oh my|bro|hermano|wow)\b/i;
const BEAT_HOOK_RE =
  /\b(mira|escucha|espera|atento|ojo|no|te juro|fijate|look|wait|watch|what)\b/i;

function round2Narrative(value: number) {
  return Number(value.toFixed(2));
}

function scoreSegmentText(text: string, regex: RegExp) {
  return regex.test(text) ? 1 : 0;
}

function countWords(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function findBestBeatEvent(
  label: BeatEvent["label"],
  moment: DetectedMoment,
  segments: TranscriptSegment[],
  sceneChanges: number[],
): BeatEvent | null {
  const clipDuration = Math.max(1, moment.end - moment.start);
  let bestScore = 0;
  let bestTimestamp = moment.start;
  let bestReason = "";

  for (const segment of segments) {
    const overlap = overlapSeconds(moment.start, moment.end, segment.start, segment.end);
    if (overlap <= 0) continue;

    const text = segment.text.trim();
    const lower = text.toLowerCase();
    const segmentCenter = (segment.start + segment.end) / 2;
    const relativeStart = (segment.start - moment.start) / clipDuration;
    const relativeCenter = (segmentCenter - moment.start) / clipDuration;
    const nearSceneChange = sceneChanges.some(
      (scene) => Math.abs(scene - segmentCenter) <= SCENE_NEAR_WINDOW_SEC,
    );

    let score = 0;
    const reasons: string[] = [];

    switch (label) {
      case "hook":
        score += Math.max(0, 18 - relativeStart * 26);
        score += Math.max(0, 14 - relativeCenter * 16);
        score += scoreSegmentText(text, BEAT_HOOK_RE) * 28;
        score += scoreSegmentText(text, BEAT_PAYOFF_RE) * 8;
        score += /[!?¡¿]/.test(text) ? 12 : 0;
        score += nearSceneChange && relativeStart <= 0.22 ? 4 : 0;
        score += countWords(text) <= 12 ? 8 : 0;
        if (BEAT_HOOK_RE.test(lower)) reasons.push("hook cue");
        if (/[!?¡¿]/.test(text)) reasons.push("punctuation");
        if (nearSceneChange) reasons.push("scene shift");
        break;
      case "setup":
        score += Math.max(0, 26 - relativeStart * 22);
        score += relativeStart <= 0.24 ? 16 : 0;
        score += scoreSegmentText(text, BEAT_SETUP_RE) * 30;
        score += /[.?!…]$/.test(text) ? 6 : 0;
        score += nearSceneChange && relativeStart <= 0.32 ? 3 : 0;
        if (BEAT_SETUP_RE.test(lower)) reasons.push("setup cue");
        if (nearSceneChange) reasons.push("scene shift");
        break;
      case "buildup":
        score += Math.max(0, 22 - Math.abs(relativeCenter - 0.38) * 42);
        score += relativeStart >= 0.10 && relativeStart <= 0.75 ? 10 : 0;
        score += scoreSegmentText(text, BEAT_BUILDCUP_RE) * 28;
        score += countWords(text) >= 6 ? 6 : 0;
        score += /[—–-]/.test(text) ? 4 : 0;
        score += nearSceneChange ? 3 : 0;
        if (BEAT_BUILDCUP_RE.test(lower)) reasons.push("buildup cue");
        if (nearSceneChange) reasons.push("scene shift");
        break;
      case "payoff":
        score += Math.max(0, relativeStart * 18);
        score += relativeStart >= 0.30 ? 10 : 0;
        score += scoreSegmentText(text, BEAT_PAYOFF_RE) * 34;
        score += /[!?¡¿]/.test(text) ? 12 : 0;
        score += nearSceneChange ? 5 : 0;
        if (BEAT_PAYOFF_RE.test(lower)) reasons.push("payoff cue");
        if (nearSceneChange) reasons.push("scene shift");
        break;
      case "reaction":
        score += Math.max(0, relativeStart * 20);
        score += relativeStart >= 0.45 ? 12 : 0;
        score += scoreSegmentText(text, BEAT_REACTION_RE) * 32;
        score += /[!?¡¿]/.test(text) ? 8 : 0;
        score += nearSceneChange ? 2 : 0;
        if (BEAT_REACTION_RE.test(lower)) reasons.push("reaction cue");
        if (nearSceneChange) reasons.push("scene shift");
        break;
    }

    const roundedScore = clamp(Math.round(score), 0, 100);
    if (roundedScore > bestScore) {
      bestScore = roundedScore;
      bestTimestamp = round2Narrative(segmentCenter);
      bestReason = reasons.length > 0 ? reasons.join(", ") : "segmento relevante";
    }
  }

  if (bestScore <= 0) return null;

  return {
    label,
    timestamp: bestTimestamp,
    score: bestScore,
    reason: bestReason,
  };
}

function beatOrderScore(events: BeatEvent[]) {
  const byLabel = new Map(events.map((event) => [event.label, event]));
  const required: BeatEvent["label"][] = ["hook", "setup", "buildup", "payoff", "reaction"];
  let score = 100;

  for (const label of required) {
    if (!byLabel.has(label)) {
      score -= 16;
    }
  }

  const ordered = required
    .map((label) => byLabel.get(label))
    .filter((event): event is BeatEvent => Boolean(event));

  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i - 1].timestamp > ordered[i].timestamp) {
      score -= 10;
    }
  }

  return clamp(score, 0, 100);
}

function buildBeatSummary(evaluation: BeatEvaluation) {
  const missing = evaluation.missingBeats.length > 0
    ? evaluation.missingBeats.join(", ")
    : "ninguno";
  const eventSummary = evaluation.events.length > 0
    ? evaluation.events
      .map((event) => `${event.label}:${event.score}@${event.timestamp.toFixed(1)}`)
      .join(" | ")
    : "sin beats claros";

  return `hook ${evaluation.hookScore} · cobertura ${evaluation.beatCoverageScore} · completitud ${evaluation.completenessScore} · engagement ${evaluation.engagementScore} · faltan ${missing} · ${eventSummary}`;
}

export function evaluateMomentBeats(params: {
  moment: DetectedMoment;
  segments: TranscriptSegment[];
  sceneChanges: number[];
}): BeatEvaluation {
  const profile = getAdaptiveScoringProfile();
  const { moment, segments, sceneChanges } = params;
  const orderedSegments = segments
    .filter((segment) => overlapSeconds(moment.start, moment.end, segment.start, segment.end) > 0)
    .sort((a, b) => a.start - b.start);

  if (orderedSegments.length === 0) {
    return {
      anchorTimestamp: round2Narrative(Math.min(Math.max(moment.zoomTimestamp ?? (moment.start + moment.end) / 2, moment.start), moment.end)),
      events: [],
      hookScore: 0,
      beatCoverageScore: 0,
      completenessScore: 0,
      narrativeScore: 0,
      engagementScore: 0,
      missingBeats: ["hook", "setup", "buildup", "payoff", "reaction"],
      flatRisk: true,
      summary: "sin transcripcion dentro del clip",
    };
  }

  const events = (["hook", "setup", "buildup", "payoff", "reaction"] as const)
    .map((label) => findBestBeatEvent(label, moment, orderedSegments, sceneChanges))
    .filter((event): event is BeatEvent => Boolean(event));

  const byLabel = new Map(events.map((event) => [event.label, event]));
  const hookScore = byLabel.get("hook")?.score ?? 0;
  const setupScore = byLabel.get("setup")?.score ?? 0;
  const buildupScore = byLabel.get("buildup")?.score ?? 0;
  const payoffScore = byLabel.get("payoff")?.score ?? 0;
  const reactionScore = byLabel.get("reaction")?.score ?? 0;
  const beatCoverageWeights = profile.weights.beatCoverage;
  const beatCoverageScore = clamp(
    Math.round(
      hookScore * beatCoverageWeights.hook +
      setupScore * beatCoverageWeights.setup +
      buildupScore * beatCoverageWeights.buildup +
      payoffScore * beatCoverageWeights.payoff +
      reactionScore * beatCoverageWeights.reaction,
    ),
    0,
    100,
  );

  const missingBeats = (["hook", "setup", "buildup", "payoff", "reaction"] as const)
    .filter((label) => !byLabel.has(label));
  const completenessScore = clamp(
    Math.round(
      beatCoverageScore * 0.68 +
      beatOrderScore(events) * 0.32,
    ),
    0,
    100,
  );

  const narrativeBlend = profile.weights.narrativeBlend;
  const narrativeScore = clamp(
    Math.round(
      completenessScore * narrativeBlend.completeness +
      beatCoverageScore * narrativeBlend.beatCoverage +
      (moment.scores.flow ?? 0) * narrativeBlend.flow +
      hookScore * narrativeBlend.hook,
    ),
    0,
    100,
  );
  const engagementBlend = profile.weights.engagementBlend;
  const engagementScore = clamp(
    Math.round(
      (moment.scores.engagement ?? 0) * engagementBlend.momentEngagement +
      Math.max(payoffScore, reactionScore) * engagementBlend.climax +
      hookScore * engagementBlend.hook,
    ),
    0,
    100,
  );
  const anchorTimestamp = (() => {
    const preferred = [byLabel.get("reaction"), byLabel.get("payoff"), byLabel.get("hook"), byLabel.get("setup")]
      .filter((event): event is BeatEvent => Boolean(event))
      .sort((a, b) => b.score - a.score || a.timestamp - b.timestamp)[0];
    if (preferred) {
      return clamp(preferred.timestamp, moment.start, moment.end);
    }
    return clamp(findAnchorTimestamp(moment, orderedSegments), moment.start, moment.end);
  })();

  const antiFlatConfig = profile.weights.antiFlat;
  const flatRisk = hookScore < antiFlatConfig.flatRiskHook && (
    missingBeats.length >= antiFlatConfig.flatRiskMissingBeats ||
    completenessScore < antiFlatConfig.flatRiskCompleteness
  );
  const evaluation: BeatEvaluation = {
    anchorTimestamp: round2Narrative(anchorTimestamp),
    events: events.sort((a, b) => a.timestamp - b.timestamp),
    hookScore,
    beatCoverageScore,
    completenessScore,
    narrativeScore,
    engagementScore,
    missingBeats,
    flatRisk,
    summary: "",
  };

  evaluation.summary = buildBeatSummary(evaluation);
  return evaluation;
}

function round2(value: number) {
  return Number(value.toFixed(2));
}

function collectStartBoundaries(
  segments: TranscriptSegment[],
  sceneChanges: number[],
  videoDuration: number,
): number[] {
  const set = new Set<number>([0]);

  for (let i = 0; i < segments.length; i += 1) {
    const current = segments[i];
    if (i === 0) {
      set.add(round2(current.start));
      continue;
    }

    const prev = segments[i - 1];
    const gap = current.start - prev.end;
    const prevEndsSentence = SEGMENT_SENTENCE_END_RE.test(prev.text.trim());
    const setupCue = SEGMENT_SETUP_CUE_RE.test(current.text.trim());

    if (gap >= SOFT_GAP_SEC || prevEndsSentence || setupCue) {
      set.add(round2(current.start));
    }
    if (gap >= HARD_GAP_SEC) {
      set.add(round2(current.start));
    }
  }

  for (const scene of sceneChanges) {
    if (!Number.isFinite(scene)) continue;
    if (scene <= 0 || scene >= videoDuration) continue;
    const rounded = round2(scene);
    const hasNearbyBoundary = [...set].some((value) => Math.abs(value - rounded) < SCENE_BOUNDARY_SNAP_MIN_GAP_SEC);
    if (!hasNearbyBoundary) {
      set.add(rounded);
    }
  }

  return [...set].sort((a, b) => a - b);
}

function collectEndBoundaries(
  segments: TranscriptSegment[],
  sceneChanges: number[],
  videoDuration: number,
): number[] {
  const set = new Set<number>([round2(videoDuration)]);

  for (let i = 0; i < segments.length; i += 1) {
    const current = segments[i];
    const next = segments[i + 1];
    const nextGap = next ? next.start - current.end : Infinity;
    const endsSentence = SEGMENT_SENTENCE_END_RE.test(current.text.trim());

    if (endsSentence || nextGap >= SOFT_GAP_SEC || i === segments.length - 1) {
      set.add(round2(current.end));
    }
    if (nextGap >= HARD_GAP_SEC) {
      set.add(round2(current.end));
    }
  }

  for (const scene of sceneChanges) {
    if (!Number.isFinite(scene)) continue;
    if (scene <= 0 || scene >= videoDuration) continue;
    const rounded = round2(scene);
    const hasNearbyBoundary = [...set].some((value) => Math.abs(value - rounded) < SCENE_BOUNDARY_SNAP_MIN_GAP_SEC);
    if (!hasNearbyBoundary) {
      set.add(rounded);
    }
  }

  return [...set].sort((a, b) => a - b);
}

function findAnchorTimestamp(
  moment: DetectedMoment,
  segments: TranscriptSegment[],
): number {
  if (
    moment.zoomTimestamp != null &&
    Number.isFinite(moment.zoomTimestamp) &&
    moment.zoomTimestamp >= moment.start &&
    moment.zoomTimestamp <= moment.end
  ) {
    return moment.zoomTimestamp;
  }

  const inside = segments.filter(
    (segment) => overlapSeconds(moment.start, moment.end, segment.start, segment.end) > 0,
  );
  if (inside.length === 0) {
    return (moment.start + moment.end) / 2;
  }

  const clipMid = (moment.start + moment.end) / 2;
  let bestCenter = clipMid;
  let bestScore = -Infinity;

  for (const segment of inside) {
    const text = segment.text.trim();
    const segCenter = (segment.start + segment.end) / 2;
    const words = text.split(/\s+/).length;
    const punctuationBoost = /[!?]/.test(text) ? 2 : SEGMENT_SENTENCE_END_RE.test(text) ? 1 : 0;
    const impactBoost = SEGMENT_IMPACT_CUE_RE.test(text) ? 2.5 : 0;
    const lengthBoost = Math.min(2, words / 12);
    const distancePenalty = Math.abs(segCenter - clipMid) * 0.08;
    const score = punctuationBoost + impactBoost + lengthBoost - distancePenalty;

    if (score > bestScore) {
      bestScore = score;
      bestCenter = segCenter;
    }
  }

  return clamp(bestCenter, moment.start, moment.end);
}

function contextWindowForMoment(moment: DetectedMoment) {
  const completeness = moment.scores.completeness;
  const flow = moment.scores.flow;
  const engagement = moment.scores.engagement;

  const preBoost = completeness < 70 ? 7 : completeness < 82 ? 4 : 2;
  const flowBoost = flow < 60 ? 4 : flow < 72 ? 2 : 0;
  const postBoost = engagement > 75 ? 4 : 2;

  return {
    pre: clamp(11 + preBoost + flowBoost, 9, 24),
    post: clamp(7 + postBoost, 6, 16),
  };
}

function pickStartBoundary(boundaries: number[], target: number, anchor: number): number {
  const maxAllowed = Math.max(0, anchor - 1);
  const minAllowed = Math.max(0, anchor - MAX_LOOKBACK_SEC);
  const boundedTarget = clamp(target, minAllowed, maxAllowed);

  const atOrBefore = boundaries.filter((value) => value >= minAllowed && value <= boundedTarget);
  if (atOrBefore.length > 0) {
    return atOrBefore[atOrBefore.length - 1];
  }

  const range = boundaries.filter((value) => value >= minAllowed && value <= maxAllowed);
  if (range.length === 0) {
    return boundedTarget;
  }

  return range.reduce((best, value) =>
    Math.abs(value - boundedTarget) < Math.abs(best - boundedTarget) ? value : best,
  );
}

function pickEndBoundary(
  boundaries: number[],
  target: number,
  anchor: number,
  videoDuration: number,
): number {
  const minAllowed = Math.min(videoDuration, anchor + 1);
  const maxAllowed = Math.min(videoDuration, anchor + MAX_LOOKAHEAD_SEC);
  const boundedTarget = clamp(target, minAllowed, maxAllowed);

  const atOrAfter = boundaries.filter((value) => value >= boundedTarget && value <= maxAllowed);
  if (atOrAfter.length > 0) {
    return atOrAfter[0];
  }

  const range = boundaries.filter((value) => value >= minAllowed && value <= maxAllowed);
  if (range.length === 0) {
    return boundedTarget;
  }

  return range.reduce((best, value) =>
    Math.abs(value - boundedTarget) < Math.abs(best - boundedTarget) ? value : best,
  );
}

function avoidAdOverlap(params: {
  start: number;
  end: number;
  anchor: number;
  adSegments: AdSegment[];
  videoDuration: number;
}) {
  let { start, end } = params;

  for (const ad of params.adSegments) {
    const overlap = overlapSeconds(start, end, ad.start, ad.end);
    if (overlap <= 0) continue;

    const duration = Math.max(1, end - start);
    const overlapRatio = overlap / duration;
    if (overlapRatio < 0.12) continue;

    const adMid = (ad.start + ad.end) / 2;
    if (params.anchor <= adMid) {
      end = Math.max(start + 8, ad.start - 0.2);
    } else {
      start = Math.min(end - 8, ad.end + 0.2);
    }
  }

  start = clamp(start, 0, params.videoDuration);
  end = clamp(end, start + 1, params.videoDuration);
  return { start, end };
}

function ensureDurationWindow(params: {
  start: number;
  end: number;
  anchor: number;
  startBoundaries: number[];
  endBoundaries: number[];
  videoDuration: number;
}) {
  let { start, end } = params;

  if (end - start < MIN_CONTEXT_DURATION_SEC) {
    const deficit = MIN_CONTEXT_DURATION_SEC - (end - start);
    const targetStart = Math.max(0, start - deficit * 0.62);
    const targetEnd = Math.min(params.videoDuration, end + deficit * 0.38);
    start = pickStartBoundary(params.startBoundaries, targetStart, params.anchor);
    end = pickEndBoundary(params.endBoundaries, targetEnd, params.anchor, params.videoDuration);

    if (end - start < MIN_CONTEXT_DURATION_SEC) {
      start = Math.max(0, params.anchor - MIN_CONTEXT_DURATION_SEC * 0.62);
      end = Math.min(params.videoDuration, start + MIN_CONTEXT_DURATION_SEC);
    }
  }

  if (end - start > MAX_CONTEXT_DURATION_SEC) {
    const targetStart = Math.max(0, params.anchor - MAX_CONTEXT_DURATION_SEC * 0.55);
    const targetEnd = Math.min(params.videoDuration, targetStart + MAX_CONTEXT_DURATION_SEC);
    start = pickStartBoundary(params.startBoundaries, targetStart, params.anchor);
    end = pickEndBoundary(params.endBoundaries, targetEnd, params.anchor, params.videoDuration);
    if (end - start > MAX_CONTEXT_DURATION_SEC) {
      end = start + MAX_CONTEXT_DURATION_SEC;
    }
  }

  start = clamp(start, 0, params.videoDuration);
  end = clamp(end, start + 1, params.videoDuration);
  return { start, end };
}

export function refineMomentsWithNarrativeContext(params: RefineMomentsParams): DetectedMoment[] {
  const { moments, segments, adSegments, sceneChanges, videoDuration, maxClips } = params;
  if (moments.length === 0) return [];

  if (segments.length === 0) {
    const deduped = deduplicateMoments(moments);
    deduped.sort((a, b) => b.overallScore - a.overallScore);
    return deduped.slice(0, maxClips);
  }

  const orderedSegments = [...segments].sort((a, b) => a.start - b.start);
  const startBoundaries = collectStartBoundaries(orderedSegments, sceneChanges, videoDuration);
  const endBoundaries = collectEndBoundaries(orderedSegments, sceneChanges, videoDuration);

  const refined = moments.map((moment) => {
    const anchor = findAnchorTimestamp(moment, orderedSegments);
    const context = contextWindowForMoment(moment);

    const targetStart = Math.max(0, Math.min(moment.start, anchor - context.pre));
    const targetEnd = Math.min(videoDuration, Math.max(moment.end, anchor + context.post));

    let start = pickStartBoundary(startBoundaries, targetStart, anchor);
    let end = pickEndBoundary(endBoundaries, targetEnd, anchor, videoDuration);

    ({ start, end } = ensureDurationWindow({
      start,
      end,
      anchor,
      startBoundaries,
      endBoundaries,
      videoDuration,
    }));

    ({ start, end } = avoidAdOverlap({
      start,
      end,
      anchor,
      adSegments,
      videoDuration,
    }));

    ({ start, end } = ensureDurationWindow({
      start,
      end,
      anchor,
      startBoundaries,
      endBoundaries,
      videoDuration,
    }));

    const zoomTimestamp =
      moment.zoomTimestamp != null
        ? clamp(moment.zoomTimestamp, start, end)
        : clamp(anchor, start, end);

    return {
      ...moment,
      start: round2(start),
      end: round2(end),
      zoomTimestamp: Number.isFinite(zoomTimestamp) ? round2(zoomTimestamp) : null,
      rationale: moment.rationale
        ? `${moment.rationale} | contexto narrativo reforzado (setup->payoff->reaccion)`
        : "Contexto narrativo reforzado (setup->payoff->reaccion).",
    };
  });

  const deduped = deduplicateMoments(refined);
  deduped.sort((a, b) => b.overallScore - a.overallScore);
  return deduped.slice(0, maxClips);
}

// ---------------------------------------------------------------------------
// Heuristic fallback — used when LLM is unavailable
// ---------------------------------------------------------------------------
// This is the old sliding-window approach, kept as fallback.
// Now produces variable-length windows by using segment boundaries.
// ---------------------------------------------------------------------------

const hookWords = [
  "mira", "escucha", "atento", "espera", "ojo", "cuidado",
  "increible", "brutal", "epico", "tremendo", "bestia", "genial", "alucinante",
  "nunca", "nadie", "jamas", "imposible", "sorpresa", "giro", "impactante",
  "secreto", "lo que paso", "la verdad", "no sabian", "resulta que", "imagina",
  "locura", "gracioso", "error", "falla",
  "viral", "momento", "esto es", "se volvio", "no puedo", "te juro",
  "look", "wait", "never", "suddenly", "literally", "actually", "insane",
  "crazy", "wild", "watch", "but then", "right here",
];

function hookCount(text: string) {
  const lower = text.toLowerCase();
  return hookWords.reduce((acc, item) => acc + (lower.includes(item) ? 1 : 0), 0);
}

export function buildHeuristicMoments(params: {
  segments: TranscriptSegment[];
  sceneChanges: number[];
  adSegments: AdSegment[];
  videoDuration: number;
  maxClips: number;
}): DetectedMoment[] {
  const profile = getAdaptiveScoringProfile();
  const clipWeights = profile.weights.clipOverall;
  const { segments, sceneChanges, adSegments, videoDuration, maxClips } = params;
  if (segments.length === 0) return [];

  // Build candidate windows of varying sizes, prioritizing context completeness.
  const baseWindow = Math.max(MIN_CLIP_DURATION_TARGET_SEC, 36);
  const windowSizes = [
    baseWindow,
    clamp(baseWindow + 12, baseWindow, 140),
    clamp(baseWindow + 24, baseWindow, 165),
    clamp(baseWindow + 36, baseWindow, 180),
  ];
  const candidates: DetectedMoment[] = [];

  for (const size of windowSizes) {
    const stride = Math.max(3, Math.floor(size * 0.25));
    const maxStart = Math.max(0, videoDuration - size);

    for (let start = 0; start <= maxStart; start += stride) {
      const end = start + size;

      // Skip if overlaps with ads
      const inAd = adSegments.some((ad) => {
        const os = Math.max(start, ad.start);
        const oe = Math.min(end, ad.end);
        return Math.max(0, oe - os) / size > 0.3;
      });
      if (inAd) continue;

      const inside = segments.filter((s) => s.end > start && s.start < end);
      const text = inside.map((s) => s.text).join(" ").trim();
      if (!text) continue;

      const words = text.split(/\s+/).length;
      const speechSeconds = inside.reduce((acc, s) => {
        return acc + Math.max(0, Math.min(end, s.end) - Math.max(start, s.start));
      }, 0);

      const speechCoverage = speechSeconds / size;
      const density = words / size;
      const hooks = hookCount(text);
      const scenes = sceneChanges.filter((t) => t >= start && t <= end).length;
      const sceneSignal = Math.min(scenes, Math.ceil(size / 8));
      const narrativeReport = evaluateNarrativeBeatReport({
        segments: inside,
        start,
        end,
      });

      // Sentence boundary check
      const first = inside[0];
      const last = inside[inside.length - 1];
      const startClean = !first || first.start >= start - 0.5 || /^[A-Z0-9"'¿¡]/.test(first.text.trim());
      const endClean = !last || last.end <= end + 0.5 || /[.!?…]$/.test(last.text.trim());

      const hookScore = clamp(Math.round(hooks * 15 + (startClean ? 20 : 0)), 0, 100);
      const flowScore = clamp(Math.round(speechCoverage * 80 + density * 5), 0, 100);
      const engagementScore = clamp(Math.round(hooks * 12 + sceneSignal * 4 + density * 8), 0, 100);
      const completenessScore = clamp(Math.round(
        (startClean ? 35 : 0) + (endClean ? 35 : 0) + speechCoverage * 30,
      ), 0, 100);

      const coreScore = Math.round(
        hookScore * clipWeights.hook +
        flowScore * clipWeights.flow +
        engagementScore * clipWeights.engagement +
        completenessScore * clipWeights.completeness,
      );
      const narrativeAdjustment = Math.round((narrativeReport.score - 50) * 0.2);
      const narrativePenalty =
        (narrativeReport.beats.payoff.score < 45 ? 14 : 0) +
        (narrativeReport.beats.setup.score < 45 ? 8 : 0) +
        (narrativeReport.beats.reaction.score < 45 ? 8 : 0) +
        ((narrativeReport.beats.setup.score < 45 || narrativeReport.beats.reaction.score < 45) ? 6 : 0);
      const overall = clamp(Math.round(coreScore + narrativeAdjustment - narrativePenalty), 0, 100);

      const preview = text.length > 300 ? `${text.slice(0, 300)}...` : text;

      candidates.push({
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        title: "Clip viral",
        hookText: normalizeHookText("", preview),
        zoomTimestamp: null,
        descriptions: { tiktok: "", instagram: "", youtube: "" },
        scores: {
          hook: hookScore,
          flow: flowScore,
          engagement: engagementScore,
          completeness: completenessScore,
        },
        overallScore: overall,
        rationale: `densidad ${density.toFixed(1)} · cobertura ${(speechCoverage * 100).toFixed(0)}% · hooks ${hooks} · escenas ${sceneSignal}/${scenes} · narrativa ${narrativeReport.score}/100${narrativePenalty > 0 ? ` (-${narrativePenalty})` : ""}`,
        transcriptPreview: preview,
      });
    }
  }

  // Sort by score, deduplicate overlaps, return top N
  candidates.sort((a, b) => b.overallScore - a.overallScore);
  const deduped = deduplicateMoments(candidates);
  return deduped.slice(0, maxClips);
}
