# ViralClips Local MVP

MVP local para generar clips verticales desde un video largo.

## Funcionalidades

- Subida de video local (MP4 y otras fuentes compatibles con FFmpeg).
- Generacion automatica de clips verticales 1080x1920.
- Overlay de titulo en parte superior.
- Overlay de marca de agua en parte inferior.
- Subtitulos automaticos opcionales con OpenAI.
- Descarga directa de cada clip generado.

## Stack

- Next.js 16 (App Router)
- React 19
- Tailwind CSS v4
- FFmpeg local
- OpenAI API opcional para transcripcion

## Requisitos

1. Node.js 20+
2. FFmpeg instalado y accesible por terminal
3. (Opcional) OPENAI_API_KEY para subtitulos automaticos

## Instalacion

```bash
npm install
copy .env.example .env.local
```

Edita `.env.local` si necesitas rutas custom:

```env
OPENAI_API_KEY=
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

## Correr en local

```bash
npm run dev
```

Abre http://localhost:3000.

## Flujo de uso

1. Sube tu video fuente.
2. Define titulo, marca de agua, cantidad de clips y duracion.
3. Ejecuta procesamiento.
4. Descarga cada clip final.

## Estructura importante

- `src/app/api/process/route.ts`: endpoint principal del pipeline.
- `src/lib/video-pipeline.ts`: recorte, overlays y transcripcion.
- `src/app/api/download/[file]/route.ts`: streaming de clips finales.
- `storage/outputs/`: clips generados.

## Notas de operacion

- Si no existe `OPENAI_API_KEY`, el sistema igualmente genera clips sin subtitulos.
- El pipeline prioriza estabilidad para MVP local, no velocidad maxima.
- Puedes limpiar `storage/outputs` y `storage/tmp` manualmente cuando quieras.
