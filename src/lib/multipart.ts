import { createWriteStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import Busboy from "busboy";
import { tempDir } from "@/lib/paths";

export type UploadResult = {
  filePath: string;
  fileName: string;
  fields: Record<string, string>;
};

/**
 * Parses multipart form data by streaming the file directly to disk.
 * This avoids loading the entire video into memory (supports multi-GB files).
 */
export function parseMultipart(request: Request): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get("content-type") ?? "";
    const fields: Record<string, string> = {};
    let filePath = "";
    let fileName = "";
    let fileReceived = false;

    // Track both busboy parsing and disk write completion separately.
    // On Windows, the write stream may still be flushing when busboy fires
    // "finish", causing ffprobe to read an incomplete file.
    let busboyDone = false;
    let writeDone = false;

    function tryResolve() {
      if (busboyDone && writeDone) {
        resolve({ filePath, fileName, fields });
      }
    }

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
      writeStream.on("finish", () => {
        writeDone = true;
        tryResolve();
      });
    });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("finish", () => {
      if (!fileReceived || !filePath) {
        reject(new Error("No se recibio ningun archivo de video."));
        return;
      }
      busboyDone = true;
      tryResolve();
    });

    busboy.on("error", (err) => reject(err));

    const body = request.body;
    if (!body) {
      reject(new Error("Request body vacio."));
      return;
    }

    const nodeStream = Readable.fromWeb(body as import("stream/web").ReadableStream);
    nodeStream.pipe(busboy);
  });
}
