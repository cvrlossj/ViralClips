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

export type TranscriptWord = {
  word: string;
  start: number;
  end: number;
};

export type TranscriptData = {
  text: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
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
    model: "whisper-1",
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
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word", "segment"],
  })) as {
    text?: string;
    segments?: Array<{
      start?: number;
      end?: number;
      text?: string;
      no_speech_prob?: number;
    }>;
    words?: Array<{
      word?: string;
      start?: number;
      end?: number;
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

  const words = (response.words ?? [])
    .map((w) => ({
      word: String(w.word ?? "").trim(),
      start: Number(w.start ?? 0),
      end: Number(w.end ?? 0),
    }))
    .filter(
      (w) =>
        w.word.length > 0 &&
        w.end > w.start &&
        Number.isFinite(w.start) &&
        Number.isFinite(w.end),
    );

  const text = String(response.text ?? "").trim();
  if (!text && segments.length === 0) {
    throw new Error("No se pudo construir la transcripcion del video.");
  }

  return { text, segments, words };
}

/**
 * Transcribe audio and return only word-level timestamps.
 * Used for karaoke-style subtitles on individual clips.
 */
export async function transcribeWords(
  inputAudioOrVideoPath: string,
): Promise<TranscriptWord[]> {
  if (!client) {
    throw new Error("OPENAI_API_KEY no configurada.");
  }

  const response = (await client.audio.transcriptions.create({
    file: fs.createReadStream(inputAudioOrVideoPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  })) as {
    words?: Array<{
      word?: string;
      start?: number;
      end?: number;
    }>;
  };

  return (response.words ?? [])
    .map((w) => ({
      word: String(w.word ?? "").trim(),
      start: Number(w.start ?? 0),
      end: Number(w.end ?? 0),
    }))
    .filter(
      (w) =>
        w.word.length > 0 &&
        w.end > w.start &&
        Number.isFinite(w.start) &&
        Number.isFinite(w.end),
    );
}
