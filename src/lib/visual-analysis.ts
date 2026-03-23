import fs from "node:fs/promises";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VisualSignal = {
  timestamp: number;
  faces: number;           // Number of faces detected
  energy: "low" | "medium" | "high" | "extreme";
  emotion: string;         // Dominant emotion: "laugh", "shock", "anger", "neutral", etc.
  visualAction: string;    // What's happening visually: "reaction shot", "crowd cheering", etc.
  viralPotential: number;  // 0-100: How visually engaging is this frame?
};

export type VisualAnalysisResult = {
  signals: VisualSignal[];
  summary: string;         // Overall visual narrative
  hotSpots: { start: number; end: number; reason: string }[];  // Visually intense ranges
};

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------

const visionClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ---------------------------------------------------------------------------
// Frame batching & analysis
// ---------------------------------------------------------------------------
// GPT-4o Vision can handle multiple images per request.
// We batch frames (up to 8 per call) to reduce API calls while giving
// the model enough visual context to understand the video flow.
// ---------------------------------------------------------------------------

const BATCH_SIZE = 8;

async function frameToBase64(framePath: string): Promise<string> {
  const buffer = await fs.readFile(framePath);
  return buffer.toString("base64");
}

function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function analyzeBatch(
  frames: { path: string; timestamp: number }[],
  transcriptContext: string,
): Promise<VisualSignal[]> {
  if (!visionClient || frames.length === 0) return [];

  // Build image content blocks
  const imageBlocks: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];

  for (const frame of frames) {
    const base64 = await frameToBase64(frame.path);
    imageBlocks.push({
      type: "text",
      text: `[Frame @ ${formatTimecode(frame.timestamp)}]`,
    });
    imageBlocks.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${base64}`,
        detail: "low", // Low detail = fewer tokens, sufficient for scene analysis
      },
    });
  }

  const timestamps = frames.map((f) => formatTimecode(f.timestamp)).join(", ");

  const response = await visionClient.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content: [
          "Eres un analista visual experto en contenido viral.",
          "Analizas frames de video para detectar momentos de alto engagement visual.",
          "Buscas: reacciones faciales extremas, gestos dramaticos, momentos de sorpresa,",
          "situaciones graciosas, energia alta, interacciones entre personas, momentos de tension.",
          "Respondes SOLO con JSON valido, sin markdown.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analiza estos ${frames.length} frames de video (timestamps: ${timestamps}).

CONTEXTO DE AUDIO/TRANSCRIPCION (para entender que pasa):
${transcriptContext.slice(0, 1000)}

Para CADA frame, responde con:
- timestamp: el timestamp en segundos
- faces: numero de caras visibles (0 si no hay)
- energy: nivel de energia visual ("low", "medium", "high", "extreme")
- emotion: emocion dominante ("laugh", "shock", "anger", "joy", "tension", "neutral", "confused", "excited")
- visualAction: descripcion corta de lo que pasa visualmente (max 15 palabras)
- viralPotential: 0-100, que tan viral es este momento VISUALMENTE

RESPONDE SOLO JSON:
{"signals":[{"timestamp":0,"faces":2,"energy":"high","emotion":"laugh","visualAction":"dos personas riendose","viralPotential":85}]}`,
          },
          ...imageBlocks,
        ],
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? "";
  const startJson = content.indexOf("{");
  const endJson = content.lastIndexOf("}");
  if (startJson < 0 || endJson <= startJson) return [];

  try {
    const parsed = JSON.parse(content.slice(startJson, endJson + 1)) as {
      signals?: Array<{
        timestamp?: number;
        faces?: number;
        energy?: string;
        emotion?: string;
        visualAction?: string;
        viralPotential?: number;
      }>;
    };

    return (parsed.signals ?? []).map((s, i) => ({
      timestamp: Number(s.timestamp ?? frames[i]?.timestamp ?? 0),
      faces: Math.max(0, Number(s.faces ?? 0)),
      energy: (["low", "medium", "high", "extreme"].includes(s.energy ?? "")
        ? s.energy
        : "medium") as VisualSignal["energy"],
      emotion: String(s.emotion ?? "neutral").slice(0, 30),
      visualAction: String(s.visualAction ?? "").slice(0, 100),
      viralPotential: Math.max(0, Math.min(100, Number(s.viralPotential ?? 50))),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main visual analysis entry point
// ---------------------------------------------------------------------------

export async function analyzeVideoVisually(params: {
  frames: { path: string; timestamp: number }[];
  transcriptContext: string;
  videoDuration: number;
}): Promise<VisualAnalysisResult | null> {
  if (!visionClient || params.frames.length === 0) return null;

  const { frames, transcriptContext, videoDuration } = params;

  // Process frames in batches
  const allSignals: VisualSignal[] = [];
  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    const batch = frames.slice(i, i + BATCH_SIZE);
    try {
      const signals = await analyzeBatch(batch, transcriptContext);
      allSignals.push(...signals);
    } catch {
      // Skip failed batches — partial results are still valuable
    }
  }

  if (allSignals.length === 0) return null;

  // Detect visual "hot spots" — contiguous high-energy ranges
  const hotSpots = detectHotSpots(allSignals, videoDuration);

  // Generate summary
  const highEnergyCount = allSignals.filter(
    (s) => s.energy === "high" || s.energy === "extreme",
  ).length;
  const avgViral = Math.round(
    allSignals.reduce((sum, s) => sum + s.viralPotential, 0) / allSignals.length,
  );
  const maxFaces = Math.max(...allSignals.map((s) => s.faces));
  const dominantEmotions = getMostFrequent(allSignals.map((s) => s.emotion), 3);

  const summary = [
    `${allSignals.length} frames analizados.`,
    `Energia alta/extrema: ${highEnergyCount}/${allSignals.length} frames.`,
    `Potencial viral promedio: ${avgViral}/100.`,
    `Max caras: ${maxFaces}.`,
    `Emociones dominantes: ${dominantEmotions.join(", ")}.`,
    `${hotSpots.length} zonas visuales calientes detectadas.`,
  ].join(" ");

  return { signals: allSignals, summary, hotSpots };
}

// ---------------------------------------------------------------------------
// Hot spot detection
// ---------------------------------------------------------------------------
// Groups consecutive high-viralPotential frames into ranges. These ranges
// are used to boost LLM moment detection scores.
// ---------------------------------------------------------------------------

function detectHotSpots(
  signals: VisualSignal[],
  videoDuration: number,
): { start: number; end: number; reason: string }[] {
  const sorted = [...signals].sort((a, b) => a.timestamp - b.timestamp);
  const HOT_THRESHOLD = 70;
  const MERGE_GAP = 15; // seconds

  const hotSpots: { start: number; end: number; signals: VisualSignal[] }[] = [];

  for (const signal of sorted) {
    if (signal.viralPotential < HOT_THRESHOLD) continue;

    const last = hotSpots[hotSpots.length - 1];
    if (last && signal.timestamp - last.end <= MERGE_GAP) {
      last.end = signal.timestamp;
      last.signals.push(signal);
    } else {
      hotSpots.push({
        start: signal.timestamp,
        end: signal.timestamp,
        signals: [signal],
      });
    }
  }

  // Expand ranges slightly for context
  return hotSpots.map((hs) => {
    const actions = hs.signals.map((s) => s.visualAction).filter(Boolean);
    const topEmotion = getMostFrequent(hs.signals.map((s) => s.emotion), 1)[0] ?? "high energy";
    const avgViral = Math.round(
      hs.signals.reduce((sum, s) => sum + s.viralPotential, 0) / hs.signals.length,
    );

    return {
      start: Math.max(0, hs.start - 3),
      end: Math.min(videoDuration, hs.end + 5),
      reason: `${topEmotion} (viral: ${avgViral}/100)${actions.length > 0 ? ` — ${actions[0]}` : ""}`,
    };
  });
}

function getMostFrequent(arr: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

// ---------------------------------------------------------------------------
// Build visual context string for LLM moment detection prompt
// ---------------------------------------------------------------------------
// Converts visual analysis results into a compact text format that can be
// appended to the LLM prompt, so it considers both audio AND visual context.
// ---------------------------------------------------------------------------

export function buildVisualContextForPrompt(result: VisualAnalysisResult): string {
  const lines: string[] = [];

  lines.push("ANALISIS VISUAL DEL VIDEO:");
  lines.push(result.summary);
  lines.push("");

  // Hot spots
  if (result.hotSpots.length > 0) {
    lines.push("ZONAS VISUALMENTE INTENSAS (priorizar clips que incluyan estas zonas):");
    for (const hs of result.hotSpots) {
      lines.push(`  ${formatTimecode(hs.start)}-${formatTimecode(hs.end)}: ${hs.reason}`);
    }
    lines.push("");
  }

  // Key signals (only high-value ones to keep prompt concise)
  const notableSignals = result.signals.filter(
    (s) => s.viralPotential >= 60 || s.energy === "high" || s.energy === "extreme",
  );
  if (notableSignals.length > 0) {
    lines.push("MOMENTOS VISUALES DESTACADOS:");
    for (const s of notableSignals.slice(0, 30)) {
      lines.push(
        `  ${formatTimecode(s.timestamp)}: ${s.emotion} / ${s.energy} / ${s.faces} caras / viral:${s.viralPotential} — ${s.visualAction}`,
      );
    }
  }

  return lines.join("\n");
}
