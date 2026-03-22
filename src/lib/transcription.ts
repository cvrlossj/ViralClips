import fs from "node:fs";
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
const client = apiKey ? new OpenAI({ apiKey }) : null;

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  noSpeechProb?: number;
};

export type TranscriptData = {
  text: string;
  segments: TranscriptSegment[];
};

export function canTranscribe() {
  return Boolean(client);
}

export async function transcribeToSrt(inputAudioOrVideoPath: string) {
  if (!client) {
    throw new Error("OPENAI_API_KEY no configurada.");
  }

  const response = await client.audio.transcriptions.create({
    file: fs.createReadStream(inputAudioOrVideoPath),
    model: "gpt-4o-mini-transcribe",
    response_format: "srt",
  });

  if (typeof response !== "string" || !response.trim()) {
    throw new Error("La API de transcripcion devolvio una respuesta vacia.");
  }

  return response;
}

export async function transcribeVerbose(
  inputAudioOrVideoPath: string,
): Promise<TranscriptData> {
  if (!client) {
    throw new Error("OPENAI_API_KEY no configurada.");
  }

  const response = (await client.audio.transcriptions.create({
    file: fs.createReadStream(inputAudioOrVideoPath),
    model: "gpt-4o-mini-transcribe",
    response_format: "verbose_json",
  })) as {
    text?: string;
    segments?: Array<{
      start?: number;
      end?: number;
      text?: string;
      no_speech_prob?: number;
    }>;
  };

  const segments = (response.segments ?? [])
    .map((segment) => ({
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      text: String(segment.text ?? "").trim(),
      noSpeechProb:
        typeof segment.no_speech_prob === "number"
          ? segment.no_speech_prob
          : undefined,
    }))
    .filter(
      (segment) =>
        segment.end > segment.start &&
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.text.length > 0,
    );

  const text = String(response.text ?? "").trim();
  if (!text && segments.length === 0) {
    throw new Error("No se pudo construir la transcripcion del video.");
  }

  return { text, segments };
}
