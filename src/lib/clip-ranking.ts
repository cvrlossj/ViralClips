import OpenAI from "openai";
import { runFfprobe } from "@/lib/ffmpeg";
import type { TranscriptSegment } from "@/lib/transcription";
import type { TranscriptWord } from "@/lib/transcription";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClipScores = {
  hook: number;       // 0-100: Do the first 3s stop the scroll?
  flow: number;       // 0-100: Does the clip maintain engagement throughout?
  engagement: number; // 0-100: Emotional intensity, humor, surprise
  completeness: number; // 0-100: Does the clip tell a complete micro-story?
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
  /** Short punchy hook text (2-5 words) for overlay */
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

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------

const llmClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

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

export async function detectSceneChangeTimes(
  videoPath: string,
  durationSeconds?: number,
): Promise<number[]> {
  try {
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

    if ((durationSeconds ?? 0) > 1800) {
      args.splice(4, 0, "-t", "1800");
    }

    const output = await runFfprobe(args);

    return output
      .split(/\r?\n/)
      .map((line) => Number(line.split(",")[0].trim()))
      .filter((value) => Number.isFinite(value) && value >= 0);
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

TU TAREA: Identifica hasta ${maxClips} momentos VIRALES del video. Cada momento debe ser un clip auto-contenido con DURACION VARIABLE (minimo 15 segundos, maximo 180 segundos).

REGLAS CRITICAS:
1. Cada clip debe tener un INICIO NATURAL (inicio de frase, momento de atencion) y un FINAL NATURAL (fin de una idea, remate, reaccion).
2. NO cortes a mitad de una oracion o momento. El clip debe sentirse COMPLETO.
3. La duracion la determina el CONTENIDO, no un numero fijo. Un chiste rapido puede ser 18s, una historia completa 90s.
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

SCORING (0-100 cada uno):
- hook: Los primeros 3 segundos del clip detienen el scroll? Hay una frase gancho, sorpresa, o tension inmediata? BONUS si hay accion visual inmediata.
- flow: El ritmo se mantiene durante todo el clip? Hay dinamismo, sin silencios muertos? Considerar variedad visual.
- engagement: Hay emocion fuerte? Humor, drama, sorpresa, tension? El espectador siente algo? Considerar reacciones faciales visibles.
- completeness: El clip cuenta una micro-historia COMPLETA con CONTEXTO? Tiene setup, buildup, payoff y reaccion? PENALIZA clips que empiezan en el punchline sin contexto.

PARA CADA MOMENTO GENERA:
- title: Titulo viral corto (6-8 palabras, sin emojis/hashtags)
- hookText: Texto ULTRA-CORTO (2-5 palabras MAX) que aparecera como overlay visual al inicio. Debe generar curiosidad INMEDIATA. Ejemplos: "NO PUEDE SER", "MIRA ESTO", "SE ARREPINTIO", "LO QUE HIZO DESPUES"
- zoomTimestamp: El segundo EXACTO dentro del clip donde ocurre el momento mas intenso (para aplicar zoom). Debe ser un timestamp absoluto del video original.
- descriptions: Objeto con 3 descripciones adaptadas a cada plataforma:
  - tiktok: Caption corta y casual con CTA. Ejemplo: "No me esperaba este final... Sigueme para mas 🔥 #viral"
  - instagram: Caption media, profesional, con hashtags. Ejemplo: "Este momento lo cambio todo 🎬 #shorts #viral #clips"
  - youtube: Descripcion para YouTube Shorts, clickbait pero real. Ejemplo: "Nadie se esperaba lo que paso en el segundo 15..."

RESPONDE UNICAMENTE CON JSON VALIDO, SIN MARKDOWN NI TEXTO ADICIONAL:
{"moments":[{"start":12.5,"end":38.2,"title":"Titulo viral corto","hookText":"NO PUEDE SER","zoomTimestamp":25.3,"descriptions":{"tiktok":"Caption TikTok...","instagram":"Caption Instagram...","youtube":"Caption YouTube..."},"hook":85,"flow":78,"engagement":92,"completeness":80,"rationale":"Por que este momento es viral"}]}

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

        // Validate: must be 15-180s, finite, within video bounds
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        if (duration < 10 || duration > 180) return null;
        if (start < 0 || end > videoDuration + 2) return null;

        const scores: ClipScores = {
          hook: clamp(Number(m.hook ?? 50), 0, 100),
          flow: clamp(Number(m.flow ?? 50), 0, 100),
          engagement: clamp(Number(m.engagement ?? 50), 0, 100),
          completeness: clamp(Number(m.completeness ?? 50), 0, 100),
        };

        // Weighted overall score (matching OpusClip's priorities)
        const overallScore = Math.round(
          scores.hook * 0.35 +
          scores.flow * 0.20 +
          scores.engagement * 0.30 +
          scores.completeness * 0.15,
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

        return {
          start: Number(start.toFixed(2)),
          end: Number(end.toFixed(2)),
          title: String(m.title ?? "").trim().slice(0, 80) || "Clip viral",
          hookText: String(m.hookText ?? "").trim().slice(0, 40).toUpperCase() || "",
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
  const { segments, sceneChanges, adSegments, videoDuration, maxClips } = params;
  if (segments.length === 0) return [];

  // Build candidate windows of varying sizes: 20s, 30s, 45s, 60s
  const windowSizes = [20, 30, 45, 60];
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

      // Sentence boundary check
      const first = inside[0];
      const last = inside[inside.length - 1];
      const startClean = !first || first.start >= start - 0.5 || /^[A-Z0-9"'¿¡]/.test(first.text.trim());
      const endClean = !last || last.end <= end + 0.5 || /[.!?…]$/.test(last.text.trim());

      const hookScore = clamp(Math.round(hooks * 15 + (startClean ? 20 : 0)), 0, 100);
      const flowScore = clamp(Math.round(speechCoverage * 80 + density * 5), 0, 100);
      const engagementScore = clamp(Math.round(hooks * 12 + scenes * 8 + density * 8), 0, 100);
      const completenessScore = clamp(Math.round(
        (startClean ? 35 : 0) + (endClean ? 35 : 0) + speechCoverage * 30,
      ), 0, 100);

      const overall = Math.round(
        hookScore * 0.35 + flowScore * 0.20 + engagementScore * 0.30 + completenessScore * 0.15,
      );

      const preview = text.length > 300 ? `${text.slice(0, 300)}...` : text;

      candidates.push({
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        title: "Clip viral",
        hookText: "",
        zoomTimestamp: null,
        descriptions: { tiktok: "", instagram: "", youtube: "" },
        scores: {
          hook: hookScore,
          flow: flowScore,
          engagement: engagementScore,
          completeness: completenessScore,
        },
        overallScore: overall,
        rationale: `densidad ${density.toFixed(1)} · cobertura ${(speechCoverage * 100).toFixed(0)}% · hooks ${hooks} · escenas ${scenes}`,
        transcriptPreview: preview,
      });
    }
  }

  // Sort by score, deduplicate overlaps, return top N
  candidates.sort((a, b) => b.overallScore - a.overallScore);
  const deduped = deduplicateMoments(candidates);
  return deduped.slice(0, maxClips);
}
