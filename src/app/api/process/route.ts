import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import Busboy from "busboy";
import { assertFfmpegInstalled } from "@/lib/ffmpeg";
import { processVideo } from "@/lib/video-pipeline";
import { tempDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const booleanPreprocess = z.preprocess((value) => {
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value;
}, z.boolean());

const formSchema = z.object({
  title: z.string().trim().max(80).default("Momento viral"),
  watermark: z.string().trim().max(50).default("@TuCanal"),
  clips: z.coerce.number().int().min(1).max(20).default(8),
  subtitleSize: z.coerce.number().int().min(24).max(56).default(44),
  splitScreen: booleanPreprocess.default(false),
  autoTitle: booleanPreprocess.default(true),
  captionPreset: z.string().trim().max(30).default("hormozi"),
  hookOptimizer: booleanPreprocess.default(true),
});

type UploadResult = {
  filePath: string;
  fileName: string;
  fields: Record<string, string>;
};

/**
 * Parses multipart form data by streaming the file directly to disk.
 * This avoids loading the entire video into memory (supports multi-GB files).
 */
function parseMultipart(request: Request): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get("content-type") ?? "";
    const fields: Record<string, string> = {};
    let filePath = "";
    let fileName = "";
    let fileReceived = false;

    const busboy = Busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
    });

    busboy.on("file", (_fieldname, stream, info) => {
      fileReceived = true;
      fileName = info.filename || "upload.mp4";
      const ext = path.extname(fileName).toLowerCase() || ".mp4";
      filePath = path.join(tempDir, `upload_${randomUUID().slice(0, 8)}${ext}`);

      const writeStream = createWriteStream(filePath);
      stream.pipe(writeStream);

      writeStream.on("error", (err) => reject(err));
    });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("finish", () => {
      if (!fileReceived || !filePath) {
        reject(new Error("No se recibio ningun archivo de video."));
        return;
      }
      resolve({ filePath, fileName, fields });
    });

    busboy.on("error", (err) => reject(err));

    // Pipe the Web ReadableStream into busboy (Node.js Readable)
    const body = request.body;
    if (!body) {
      reject(new Error("Request body vacio."));
      return;
    }

    const nodeStream = Readable.fromWeb(body as import("stream/web").ReadableStream);
    nodeStream.pipe(busboy);
  });
}

export async function POST(request: Request) {
  try {
    await Promise.all([
      assertFfmpegInstalled(),
      fs.mkdir(tempDir, { recursive: true }),
    ]);

    const { filePath, fileName, fields } = await parseMultipart(request);

    const payload = formSchema.parse({
      title: fields.title,
      watermark: fields.watermark,
      clips: fields.clips,
      subtitleSize: fields.subtitleSize,
      splitScreen: fields.splitScreen,
      autoTitle: fields.autoTitle,
      captionPreset: fields.captionPreset,
      hookOptimizer: fields.hookOptimizer,
    });

    const result = await processVideo({
      filePath,
      fileName,
      title: payload.title,
      watermark: payload.watermark,
      clipCount: payload.clips,
      subtitleSize: payload.subtitleSize,
      splitScreen: payload.splitScreen,
      autoTitle: payload.autoTitle,
      captionPreset: payload.captionPreset,
      hookOptimizer: payload.hookOptimizer,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Error interno procesando el video.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
