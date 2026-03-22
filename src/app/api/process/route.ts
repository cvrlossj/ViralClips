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
  clips: z.coerce.number().int().min(1).max(12).default(6),
  clipDuration: z.coerce.number().int().min(8).max(90).default(28),
  subtitleSize: z.coerce.number().int().min(16).max(40).default(24),
  smartMode: booleanPreprocess.default(true),
  splitScreen: booleanPreprocess.default(false),
  autoTitle: booleanPreprocess.default(false),
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
      clipDuration: fields.clipDuration,
      subtitleSize: fields.subtitleSize,
      smartMode: fields.smartMode,
      splitScreen: fields.splitScreen,
      autoTitle: fields.autoTitle,
    });

    const result = await processVideo({
      filePath,
      fileName,
      title: payload.title,
      watermark: payload.watermark,
      clipCount: payload.clips,
      clipDuration: payload.clipDuration,
      subtitleSize: payload.subtitleSize,
      smartMode: payload.smartMode,
      splitScreen: payload.splitScreen,
      autoTitle: payload.autoTitle,
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
