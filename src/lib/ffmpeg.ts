import { spawn } from "node:child_process";

const ffmpegBin = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobeBin = process.env.FFPROBE_PATH ?? "ffprobe";

function runBinary(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(
        new Error(
          `Error ejecutando ${binary} (code ${code ?? "null"}): ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}

export async function runFfprobe(args: string[]) {
  return runBinary(ffprobeBin, args);
}

export function ensureTextForDrawText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,");
}

export function ensurePathForSubtitlesFilter(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

export async function assertFfmpegInstalled() {
  await runBinary(ffmpegBin, ["-version"]);
  await runBinary(ffprobeBin, ["-version"]);
}

export async function getMediaDurationSeconds(filePath: string): Promise<number> {
  const output = await runBinary(ffprobeBin, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);

  const parsed = Number(output);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("No se pudo leer la duracion del video.");
  }

  return parsed;
}

export async function getMediaDimensions(
  filePath: string,
): Promise<{ width: number; height: number }> {
  const output = await runBinary(ffprobeBin, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0:s=x",
    filePath,
  ]);
  const parts = output.trim().split("x");
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("No se pudieron leer las dimensiones del video.");
  }
  return { width, height };
}

/**
 * Extracts audio from a video file to a compressed mono MP3 (16kHz).
 * Whisper accepts max 25MB — this reduces a multi-GB video to a few MB of audio.
 */
export async function extractCompressedAudio(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await runBinary(ffmpegBin, [
    "-y",
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    "-f", "mp3",
    outputPath,
  ]);
}

export async function runFfmpeg(args: string[]) {
  await runBinary(ffmpegBin, args);
}
