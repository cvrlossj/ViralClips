import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertFfmpegInstalled } from "@/lib/ffmpeg";
import { compileLongformVideo } from "@/lib/longform-pipeline";
import { tempDir } from "@/lib/paths";
import { parseMultipart } from "@/lib/multipart";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const booleanPreprocess = z.preprocess((value) => {
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value;
}, z.boolean());

const formSchema = z.object({
  targetDuration: z.coerce
    .number()
    .int()
    .refine((v) => [5, 7, 10].includes(v), { message: "Duracion debe ser 5, 7 o 10 minutos" })
    .default(7),
  format: z.enum(["horizontal", "vertical"]).default("horizontal"),
  style: z.enum(["compilation", "story-arc", "thematic"]).default("compilation"),
  includeIntroOutro: booleanPreprocess.default(true),
  includeChapters: booleanPreprocess.default(true),
  creatorName: z
    .string()
    .trim()
    .max(80)
    .default(process.env.LONGFORM_DEFAULT_CREATOR_NAME ?? "Yeferson Cossio"),
});

export async function POST(request: Request) {
  try {
    await Promise.all([
      assertFfmpegInstalled(),
      fs.mkdir(tempDir, { recursive: true }),
    ]);

    const { filePath, fileName, fields } = await parseMultipart(request);

    const payload = formSchema.parse({
      targetDuration: fields.targetDuration,
      format: fields.format,
      style: fields.style,
      includeIntroOutro: fields.includeIntroOutro,
      includeChapters: fields.includeChapters,
      creatorName: fields.creatorName,
    });

    const result = await compileLongformVideo({
      filePath,
      fileName,
      targetDurationMinutes: payload.targetDuration as 5 | 7 | 10,
      format: payload.format,
      style: payload.style,
      includeIntroOutro: payload.includeIntroOutro,
      includeChapters: payload.includeChapters,
      creatorName: payload.creatorName,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Error interno procesando el video largo.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
