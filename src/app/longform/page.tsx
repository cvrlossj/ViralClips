"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Film,
  Loader2,
  Upload,
  Youtube,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TopNav } from "@/components/top-nav";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChapterMarker = {
  timestampSeconds: number;
  title: string;
};

type YouTubeMetadata = {
  title: string;
  description: string;
  tags: string[];
  chapters: ChapterMarker[];
  thumbnailUrl?: string;
};

type LongformResult = {
  jobId: string;
  fileName: string;
  url: string;
  thumbnailUrl?: string;
  durationSeconds: number;
  momentCount: number;
  youtubeMetadata: YouTubeMetadata;
  notes: string[];
};

type LongformStyle = "compilation" | "story-arc" | "thematic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secondsToTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

function formatFileSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// CopyButton component
// ---------------------------------------------------------------------------

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
        copied
          ? "bg-emerald-500/20 text-emerald-300"
          : "bg-(--muted)/30 text-(--muted-fg) hover:bg-(--muted)/50 hover:text-(--foreground)"
      } ${className ?? ""}`}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copiado" : "Copiar"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function LongformPage() {
  // Form state
  const [video, setVideo] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [creatorName, setCreatorName] = useState("Yeferson Cossio");
  const [targetDuration, setTargetDuration] = useState<5 | 7 | 10>(7);
  const [format, setFormat] = useState<"horizontal" | "vertical">("horizontal");
  const [style, setStyle] = useState<LongformStyle>("compilation");
  const [includeIntroOutro, setIncludeIntroOutro] = useState(true);
  const [includeChapters, setIncludeChapters] = useState(true);

  // Pipeline state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LongformResult | null>(null);
  const [progressValue, setProgressValue] = useState(0);
  const [progressStage, setProgressStage] = useState("En espera");
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);

  // UI state
  const [showNotes, setShowNotes] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Progress simulation
  useEffect(() => {
    if (!loading || processingStartedAt === null) return;

    const fileSizeMb = video ? video.size / (1024 * 1024) : 100;
    const uploadTimeSec = fileSizeMb / 15;
    const transcriptionSec = Math.max(30, fileSizeMb * 0.12);
    const sceneSec = Math.max(15, fileSizeMb * 0.06);
    const visualSec = Math.max(20, fileSizeMb * 0.06);
    const extractSec = 15 * 8; // ~15 segments * 8s each
    const assembleSec = 15 * 3;
    const metadataSec = 15;
    const estimateMs =
      (uploadTimeSec + transcriptionSec + sceneSec + visualSec + extractSec + assembleSec + metadataSec) * 1000;

    const stages = [
      { at: 0.0, label: "Subiendo video" },
      { at: 0.08, label: "Transcribiendo audio" },
      { at: 0.28, label: "Analizando frames (Vision AI)" },
      { at: 0.42, label: "Seleccionando mejores momentos" },
      { at: 0.55, label: "Extrayendo segmentos" },
      { at: 0.72, label: "Ensamblando con transiciones" },
      { at: 0.88, label: "Generando metadata YouTube" },
    ];

    const update = () => {
      const elapsed = Date.now() - processingStartedAt;
      const ratio = elapsed / estimateMs;
      const projected = Math.min(94, 6 + 88 * (1 - Math.exp(-2.5 * ratio)));
      setProgressValue((prev) => (projected > prev ? projected : prev));

      const currentStage = stages.slice().reverse().find((s) => ratio >= s.at);
      if (currentStage) setProgressStage(currentStage.label);
    };

    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [loading, processingStartedAt, video]);

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) setVideo(file);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!video) return;

    const form = new FormData();
    form.append("video", video);
    form.append("targetDuration", String(targetDuration));
    form.append("format", format);
    form.append("style", style);
    form.append("includeIntroOutro", String(includeIntroOutro));
    form.append("includeChapters", String(includeChapters));
    form.append("creatorName", creatorName);

    setLoading(true);
    setError(null);
    setResult(null);
    setProgressValue(4);
    setProgressStage("Subiendo video");
    setProcessingStartedAt(Date.now());

    try {
      const res = await fetch("/api/process-longform", { method: "POST", body: form });
      if (!res.ok) {
        const payload = (await res.json()) as { error?: string };
        throw new Error(payload.error ?? "No se pudo procesar el video.");
      }
      const payload = (await res.json()) as LongformResult;
      setResult(payload);
      setProgressStage("Completado");
      setProgressValue(100);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error inesperado.";
      setError(msg);
      setProgressStage("Error");
    } finally {
      setLoading(false);
      setProcessingStartedAt(null);
    }
  };

  const chapterBlock = result?.youtubeMetadata.chapters
    .map((c) => `${secondsToTimestamp(c.timestampSeconds)} ${c.title}`)
    .join("\n") ?? "";

  return (
    <div className="grain min-h-screen">
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-8">
        <TopNav />

        {/* Hero */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Videos largos{" "}
            <span className="text-(--accent)">para YouTube</span>
          </h1>
          <p className="mt-3 max-w-2xl text-base text-(--muted-fg)">
            Sube un video largo. El motor selecciona los mejores momentos y los ensambla en una
            compilacion de 5-10 minutos en 16:9, lista para subir a YouTube con titulo, descripcion,
            tags y chapter markers generados por IA.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">

          {/* Left — form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-xl">Configurar compilacion</CardTitle>
              <CardDescription>Configura el video y los parametros de generacion.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit}>
                <Tabs defaultValue="video">
                  <TabsList className="mb-4">
                    <TabsTrigger value="video">
                      <Upload className="mr-1.5 h-3.5 w-3.5" />
                      Video
                    </TabsTrigger>
                    <TabsTrigger value="config">
                      <Film className="mr-1.5 h-3.5 w-3.5" />
                      Configuracion
                    </TabsTrigger>
                  </TabsList>

                  {/* Tab: Video upload */}
                  <TabsContent value="video">
                    <div
                      className={`relative flex min-h-[220px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors ${
                        isDragging
                          ? "border-(--accent) bg-(--accent)/5"
                          : video
                            ? "border-emerald-500/40 bg-emerald-500/5"
                            : "border-(--line) hover:border-(--accent)/50 hover:bg-(--surface-2)"
                      }`}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/mp4,video/quicktime,video/avi,video/x-matroska,video/webm,.mp4,.mov,.avi,.mkv,.webm"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) setVideo(f);
                        }}
                      />

                      {video ? (
                        <div className="flex flex-col items-center gap-2 text-center">
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15">
                            <Film className="h-6 w-6 text-emerald-400" />
                          </div>
                          <p className="font-medium">{video.name}</p>
                          <p className="text-sm text-(--muted-fg)">{formatFileSize(video.size)}</p>
                          <button
                            type="button"
                            className="mt-1 text-xs text-(--muted-fg) underline-offset-2 hover:underline"
                            onClick={(ev) => { ev.stopPropagation(); setVideo(null); }}
                          >
                            Cambiar video
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-3 text-center">
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-(--muted)/30">
                            <Upload className="h-6 w-6 text-(--muted-fg)" />
                          </div>
                          <div>
                            <p className="font-medium">Arrastra tu video aqui</p>
                            <p className="text-sm text-(--muted-fg)">o haz clic para seleccionar</p>
                          </div>
                          <p className="text-xs text-(--muted-fg)">MP4 · MOV · AVI · MKV · WebM</p>
                        </div>
                      )}
                    </div>
                  </TabsContent>

                  {/* Tab: Config */}
                  <TabsContent value="config" className="space-y-6">

                    {/* Creator name */}
                    <div className="space-y-2">
                      <Label>Nombre del creador</Label>
                      <Input
                        value={creatorName}
                        onChange={(e) => setCreatorName(e.target.value)}
                        placeholder="Yeferson Cossio"
                        maxLength={80}
                      />
                      <p className="text-xs text-(--muted-fg)">
                        Usado en el intro, outro y metadata de YouTube.
                      </p>
                    </div>

                    {/* Duration */}
                    <div className="space-y-2">
                      <Label>Duracion objetivo</Label>
                      <div className="flex gap-2">
                        {([5, 7, 10] as const).map((d) => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setTargetDuration(d)}
                            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                              targetDuration === d
                                ? "border-(--accent) bg-(--accent) text-(--accent-fg)"
                                : "border-(--line) bg-(--surface) text-(--muted-fg) hover:border-(--accent)/50 hover:text-(--foreground)"
                            }`}
                          >
                            {d} min
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-(--muted-fg)">
                        10 min habilita mid-roll ads (mayor RPM en YouTube).
                      </p>
                    </div>

                    {/* Format */}
                    <div className="space-y-2">
                      <Label>Formato</Label>
                      <div className="flex gap-2">
                        {(["horizontal", "vertical"] as const).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setFormat(f)}
                            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                              format === f
                                ? "border-(--accent) bg-(--accent) text-(--accent-fg)"
                                : "border-(--line) bg-(--surface) text-(--muted-fg) hover:border-(--accent)/50 hover:text-(--foreground)"
                            }`}
                          >
                            {f === "horizontal" ? "Horizontal 16:9" : "Vertical 9:16"}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Style */}
                    <div className="space-y-2">
                      <Label>Estilo de compilacion</Label>
                      <div className="flex gap-2">
                        {(["compilation", "story-arc", "thematic"] as const).map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setStyle(s)}
                            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                              style === s
                                ? "border-(--accent) bg-(--accent) text-(--accent-fg)"
                                : "border-(--line) bg-(--surface) text-(--muted-fg) hover:border-(--accent)/50 hover:text-(--foreground)"
                            }`}
                          >
                            {s === "compilation" ? "Compilacion" : s === "story-arc" ? "Arco narrativo" : "Tematico"}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-(--muted-fg)">
                        {style === "compilation" && "Orden cronologico. Mejor variedad y ritmo."}
                        {style === "story-arc" && "Inicio, desarrollo y climax. Mejor para historias."}
                        {style === "thematic" && "Agrupa momentos por emocion/tema."}
                      </p>
                    </div>

                    {/* Toggles */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label>Intro y outro</Label>
                          <p className="text-xs text-(--muted-fg)">Tarjeta con nombre del creador al inicio y final.</p>
                        </div>
                        <Switch checked={includeIntroOutro} onCheckedChange={setIncludeIntroOutro} />
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <Label>Chapter markers</Label>
                          <p className="text-xs text-(--muted-fg)">Timestamps para navegacion en YouTube.</p>
                        </div>
                        <Switch checked={includeChapters} onCheckedChange={setIncludeChapters} />
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>

                <div className="mt-6">
                  <Button
                    type="submit"
                    disabled={!video || loading}
                    className="w-full"
                    size="lg"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Generando compilacion...
                      </>
                    ) : (
                      <>
                        <Youtube className="mr-2 h-4 w-4" />
                        Generar video de {targetDuration} minutos
                      </>
                    )}
                  </Button>
                  {!video && (
                    <p className="mt-2 text-center text-sm text-(--muted-fg)">
                      Selecciona un video en la pestana Video para comenzar.
                    </p>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Right — status panel */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Youtube className="h-4 w-4 text-(--accent)" />
                  Estado del pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-lg bg-(--surface-2) px-3 py-2 text-sm text-(--muted-fg)">
                  {loading ? progressStage : result ? "Compilacion lista." : "En espera de configuracion."}
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-(--muted-fg)">
                    <span>{loading ? progressStage : result ? "Completado" : "En espera"}</span>
                    <span>{loading ? `${Math.round(progressValue)}%` : result ? "100%" : "0%"}</span>
                  </div>
                  <Progress value={result ? 100 : loading ? progressValue : 0} className="h-1.5" />
                </div>

                {/* Feature list */}
                <div className="space-y-1 pt-1">
                  {[
                    ["Transcripcion Whisper-1", true],
                    ["Analisis visual GPT-4o Vision", true],
                    ["Seleccion orientada a watch time", true],
                    ["Transiciones crossfade", true],
                    [`Intro y outro (${includeIntroOutro ? "activo" : "inactivo"})`, includeIntroOutro],
                    [`Chapter markers (${includeChapters ? "activo" : "inactivo"})`, includeChapters],
                    ["Titulo y descripcion con IA", true],
                    ["Tags SEO (25-30 tags)", true],
                    [`Formato ${format === "horizontal" ? "16:9" : "9:16"}`, true],
                  ].map(([label, active]) => (
                    <div key={String(label)} className="flex items-center justify-between text-xs">
                      <span className="text-(--muted-fg)">{String(label)}</span>
                      <span className={active ? "text-emerald-400" : "text-(--muted-fg)"}>
                        {active ? "activo" : "inactivo"}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Monetization tip */}
            <Card className="border-(--accent)/20 bg-(--accent)/5">
              <CardContent className="py-4">
                <p className="text-sm font-medium text-(--accent)">Tip de monetizacion</p>
                <p className="mt-1 text-xs text-(--muted-fg)">
                  Videos de 10+ min habilitan mid-roll ads (mayor RPM). Con 2-3 compilaciones por semana,
                  alcanzas las 4,000 watch hours en ~6 meses.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="mt-8 space-y-6">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-bold">Compilacion generada</h2>
              <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/25">
                {formatDuration(result.durationSeconds)} · {result.momentCount} momentos
              </Badge>
            </div>

            <div className="grid gap-6 lg:grid-cols-[1fr_420px]">

              {/* Video player */}
              <Card>
                <CardContent className="p-4">
                  <video
                    src={result.url}
                    poster={result.thumbnailUrl}
                    controls
                    className={`w-full rounded-lg bg-black ${format === "horizontal" ? "aspect-video" : "mx-auto max-w-xs aspect-[9/16]"}`}
                  />
                  <div className="mt-4 flex gap-3">
                    <a href={result.url} download className="flex-1">
                      <Button className="w-full" variant="default">
                        <Download className="mr-2 h-4 w-4" />
                        Descargar MP4
                      </Button>
                    </a>
                    {result.thumbnailUrl && (
                      <a href={result.thumbnailUrl} download>
                        <Button variant="outline">
                          Thumbnail
                        </Button>
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* YouTube Metadata */}
              <div className="space-y-4">

                {/* Title */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-(--muted-fg)">TITULO YOUTUBE</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-sm font-semibold leading-snug">{result.youtubeMetadata.title}</p>
                    <div className="flex items-center justify-between text-xs text-(--muted-fg)">
                      <span>{result.youtubeMetadata.title.length}/70 chars</span>
                      <CopyButton text={result.youtubeMetadata.title} />
                    </div>
                  </CardContent>
                </Card>

                {/* Description */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm font-medium text-(--muted-fg)">
                      DESCRIPCION
                      <CopyButton text={result.youtubeMetadata.description} />
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <textarea
                      readOnly
                      value={result.youtubeMetadata.description}
                      className="h-32 w-full resize-none rounded-lg bg-(--surface-2) p-2 text-xs leading-relaxed text-(--foreground) focus:outline-none"
                    />
                  </CardContent>
                </Card>

                {/* Tags */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm font-medium text-(--muted-fg)">
                      TAGS SEO ({result.youtubeMetadata.tags.length})
                      <CopyButton text={result.youtubeMetadata.tags.join(", ")} />
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-1.5">
                      {result.youtubeMetadata.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Chapters */}
                {result.youtubeMetadata.chapters.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="flex items-center justify-between text-sm font-medium text-(--muted-fg)">
                        CHAPTER MARKERS
                        <CopyButton text={chapterBlock} />
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-1">
                        {result.youtubeMetadata.chapters.map((ch) => (
                          <div key={ch.timestampSeconds} className="flex gap-3 text-xs">
                            <span className="shrink-0 font-mono text-(--accent)">
                              {secondsToTimestamp(ch.timestampSeconds)}
                            </span>
                            <span className="text-(--foreground)">{ch.title}</span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>

            {/* Pipeline notes (collapsible) */}
            {result.notes.length > 0 && (
              <div>
                <button
                  type="button"
                  className="flex items-center gap-2 text-sm text-(--muted-fg) hover:text-(--foreground)"
                  onClick={() => setShowNotes((v) => !v)}
                >
                  {showNotes ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  Notas del pipeline ({result.notes.length})
                </button>
                {showNotes && (
                  <div className="mt-2 rounded-lg bg-(--surface-2) p-3 space-y-1">
                    {result.notes.map((note, i) => (
                      <p key={i} className="text-xs text-(--muted-fg)">
                        · {note}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
