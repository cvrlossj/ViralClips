"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Cpu,
  Download,
  Film,
  Loader2,
  Settings2,
  Type,
  Upload,
  XCircle,
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
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ClipResult = {
  fileName: string;
  url: string;
  startSeconds: number;
  durationSeconds: number;
  hasSubtitles: boolean;
  score: number;
  rationale: string;
  title: string;
};

type ProcessResponse = {
  jobId: string;
  clips: ClipResult[];
  notes: string[];
};

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatFileSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// Dot indicator for status
function StatusDot({ state }: { state: "ok" | "error" | "loading" }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        state === "ok"
          ? "bg-(--accent-2)"
          : state === "error"
            ? "bg-red-500"
            : "bg-yellow-500 animate-pulse"
      }`}
    />
  );
}

export default function Home() {
  const [video, setVideo] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [title, setTitle] = useState("Momento viral del dia");
  const [watermark, setWatermark] = useState("@TuCanal");
  const [clipCount, setClipCount] = useState(6);
  const [clipDuration, setClipDuration] = useState(28);
  const [subtitleSize, setSubtitleSize] = useState(24);
  const [smartMode, setSmartMode] = useState(true);
  const [splitScreen, setSplitScreen] = useState(false);
  const [autoTitle, setAutoTitle] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ProcessResponse | null>(null);
  const [processingStatus, setProcessingStatus] = useState(
    "En espera de configuracion.",
  );
  const [backendReady, setBackendReady] = useState<boolean | null>(null);
  const [backendMessage, setBackendMessage] = useState("Verificando sistema...");
  const [progressValue, setProgressValue] = useState(0);
  const [progressStage, setProgressStage] = useState("En espera");
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const payload = (await res.json()) as {
          ok?: boolean;
          message?: string;
          detail?: string;
        };
        if (!mounted) return;
        if (res.ok && payload.ok) {
          setBackendReady(true);
          setBackendMessage(payload.message ?? "Sistema listo.");
        } else {
          setBackendReady(false);
          setBackendMessage(payload.message ?? payload.detail ?? "Backend no disponible.");
        }
      } catch {
        if (!mounted) return;
        setBackendReady(false);
        setBackendMessage("No se pudo conectar con el backend.");
      }
    };
    void check();
    return () => { mounted = false; };
  }, []);

  const canSubmit = useMemo(
    () => Boolean(video) && !loading && backendReady !== false,
    [video, loading, backendReady],
  );

  useEffect(() => {
    if (!loading || processingStartedAt === null) return;

    // Estimate based on file size + pipeline features
    const fileSizeMb = video ? video.size / (1024 * 1024) : 50;
    const uploadTimeSec = fileSizeMb / 15; // ~15 MB/s local write
    const transcriptionSec = smartMode ? Math.max(30, fileSizeMb * 0.12) : 0;
    const sceneSec = smartMode ? Math.max(20, fileSizeMb * 0.08) : 0;
    const renderSec = clipCount * Math.max(8, clipDuration * 0.5);
    const titleSec = smartMode ? clipCount * 3 : 0;
    const estimateMs = (uploadTimeSec + transcriptionSec + sceneSec + renderSec + titleSec) * 1000;

    const update = () => {
      const elapsed = Date.now() - processingStartedAt;
      // Progress curve: fast start, slows down as it approaches 94%
      const ratio = elapsed / estimateMs;
      const projected = Math.min(94, 6 + 88 * (1 - Math.exp(-2.5 * ratio)));
      setProgressValue((prev) => (projected > prev ? projected : prev));

      const remaining = Math.max(0, estimateMs - elapsed);
      // When past the estimate, show "procesando" instead of "0s"
      setEtaSeconds(remaining > 1000 ? Math.ceil(remaining / 1000) : null);

      // Dynamic stage based on elapsed proportion
      if (ratio < 0.1) setProgressStage("Subiendo video");
      else if (ratio < 0.4) setProgressStage("Transcribiendo audio");
      else if (ratio < 0.55) setProgressStage("Generando titulos");
      else if (ratio < 0.7) setProgressStage("Analizando escenas");
      else setProgressStage("Renderizando clips");
    };

    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, [loading, processingStartedAt, clipCount, clipDuration, smartMode, video]);

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
    form.append("title", title);
    form.append("watermark", watermark);
    form.append("clips", String(clipCount));
    form.append("clipDuration", String(clipDuration));
    form.append("subtitleSize", String(subtitleSize));
    form.append("smartMode", String(smartMode));
    form.append("splitScreen", String(splitScreen));
    form.append("autoTitle", String(autoTitle));

    setLoading(true);
    setError(null);
    setResponse(null);
    setProgressValue(4);
    setProgressStage("Subiendo video");
    setEtaSeconds(null);
    setProcessingStartedAt(Date.now());
    setProcessingStatus("Procesando...");

    try {
      const res = await fetch("/api/process", { method: "POST", body: form });
      if (!res.ok) {
        const payload = (await res.json()) as { error?: string };
        throw new Error(payload.error ?? "No se pudo procesar el video.");
      }
      const payload = (await res.json()) as ProcessResponse;
      setResponse(payload);
      setProcessingStatus("Clips generados correctamente.");
      setProgressStage("Completado");
      setProgressValue(100);
      setEtaSeconds(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error inesperado.";
      setError(msg);
      setProcessingStatus("Fallo en el pipeline.");
      setProgressStage("Error");
    } finally {
      setLoading(false);
      setProcessingStartedAt(null);
    }
  };

  return (
    <div className="grain min-h-screen">
      {/* Top nav */}
      <header className="sticky top-0 z-20 border-b border-(--line) bg-(--background)/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-(--accent)">
              <Film className="h-4 w-4 text-white" />
            </div>
            <span className="font-semibold tracking-tight">ViralClips</span>
            <Badge variant="accent" className="font-mono text-[10px]">
              AI STUDIO
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <StatusDot
              state={
                backendReady === null ? "loading" : backendReady ? "ok" : "error"
              }
            />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-8">
        {/* Hero */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Generador de{" "}
            <span className="text-(--accent)">clips virales</span>
          </h1>
          <p className="mt-3 max-w-2xl text-base text-(--muted-fg)">
            Sube un video largo. El motor transcribe el audio, detecta escenas clave y aplica
            re-ranking con LLM para elegir los momentos mas enganches. Salida vertical
            1080x1920 lista para publicar.
          </p>
        </div>

        {/* Main layout */}
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">

          {/* Left — tabbed form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-xl">Configuracion del pipeline</CardTitle>
              <CardDescription>
                Configura el video, los textos y los parametros de generacion.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
                <Tabs defaultValue="video">
                  <TabsList className="w-full sm:w-auto">
                    <TabsTrigger value="video" className="flex items-center gap-1.5">
                      <Upload className="h-3.5 w-3.5" />
                      Video
                    </TabsTrigger>
                    <TabsTrigger value="texto" className="flex items-center gap-1.5">
                      <Type className="h-3.5 w-3.5" />
                      Overlay
                    </TabsTrigger>
                    <TabsTrigger value="clips" className="flex items-center gap-1.5">
                      <Settings2 className="h-3.5 w-3.5" />
                      Pipeline
                    </TabsTrigger>
                  </TabsList>

                  {/* Tab: Video upload */}
                  <TabsContent value="video">
                    <div
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`group cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-all duration-200 ${
                        isDragging
                          ? "border-(--accent) bg-(--accent)/8 scale-[1.01]"
                          : "border-(--line-2) bg-(--surface-2) hover:border-(--accent)/50 hover:bg-(--surface-3)"
                      }`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(e) => setVideo(e.target.files?.[0] ?? null)}
                      />

                      {video ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-center gap-2">
                            <CheckCircle2 className="h-5 w-5 text-(--accent-2)" />
                            <p className="font-semibold truncate max-w-xs">{video.name}</p>
                          </div>
                          <p className="text-sm text-(--muted-fg)">
                            {formatFileSize(video.size)} · {video.type || "video"}
                          </p>
                          <p className="text-xs text-(--muted-fg)/60 mt-2">
                            Clic para cambiar el archivo
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-(--surface-3) group-hover:bg-(--accent)/15 transition-colors">
                            <Upload className="h-5 w-5 text-(--muted-fg) group-hover:text-(--accent) transition-colors" />
                          </div>
                          <div>
                            <p className="font-medium">Arrastra tu video aqui</p>
                            <p className="text-sm text-(--muted-fg) mt-0.5">
                              o haz clic para seleccionar
                            </p>
                          </div>
                          <p className="text-xs text-(--muted-fg)/60">
                            MP4 · MOV · AVI · MKV · WebM
                          </p>
                        </div>
                      )}
                    </div>
                  </TabsContent>

                  {/* Tab: Text overlays */}
                  <TabsContent value="texto" className="space-y-5">
                    <div className="flex items-center justify-between rounded-lg border border-(--line) bg-(--surface-2) px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">Auto-titulo viral</p>
                        <p className="text-xs text-(--muted-fg) mt-0.5">
                          GPT genera un titulo unico y enganchante por cada clip.
                        </p>
                      </div>
                      <Switch checked={autoTitle} onCheckedChange={setAutoTitle} />
                    </div>

                    <div className={`space-y-2 transition-opacity ${autoTitle ? "opacity-40 pointer-events-none" : ""}`}>
                      <Label htmlFor="title">Titulo superior (manual)</Label>
                      <Input
                        id="title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Lo que paso en este stream..."
                        maxLength={80}
                        disabled={autoTitle}
                      />
                      <p className="text-xs text-(--muted-fg)">
                        {autoTitle
                          ? "Desactiva auto-titulo para escribir un titulo fijo."
                          : "Aparece en la barra oscura del top del video."}
                      </p>
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <Label htmlFor="watermark">Marca de agua</Label>
                      <Input
                        id="watermark"
                        value={watermark}
                        onChange={(e) => setWatermark(e.target.value)}
                        placeholder="@TuCanal"
                        maxLength={50}
                      />
                      <p className="text-xs text-(--muted-fg)">
                        Aparece en la barra inferior del video.
                      </p>
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Tamano de subtitulos</Label>
                        <span className="font-mono text-sm text-(--accent)">{subtitleSize}px</span>
                      </div>
                      <Slider
                        min={16}
                        max={36}
                        step={1}
                        value={[subtitleSize]}
                        onValueChange={([v]) => setSubtitleSize(v)}
                      />
                      <div className="flex justify-between text-xs text-(--muted-fg)">
                        <span>Pequeno (16px)</span>
                        <span>Grande (36px)</span>
                      </div>
                    </div>
                  </TabsContent>

                  {/* Tab: Pipeline settings */}
                  <TabsContent value="clips" className="space-y-5">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Numero de clips</Label>
                        <span className="font-mono text-sm text-(--accent)">{clipCount}</span>
                      </div>
                      <Slider
                        min={1}
                        max={12}
                        step={1}
                        value={[clipCount]}
                        onValueChange={([v]) => setClipCount(v)}
                      />
                      <div className="flex justify-between text-xs text-(--muted-fg)">
                        <span>1 clip</span>
                        <span>12 clips</span>
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label>Duracion por clip</Label>
                        <span className="font-mono text-sm text-(--accent)">{clipDuration}s</span>
                      </div>
                      <Slider
                        min={8}
                        max={90}
                        step={1}
                        value={[clipDuration]}
                        onValueChange={([v]) => setClipDuration(v)}
                      />
                      <div className="flex justify-between text-xs text-(--muted-fg)">
                        <span>8s (corto)</span>
                        <span>90s (largo)</span>
                      </div>
                    </div>

                    <Separator />

                    <div className="flex items-center justify-between rounded-lg border border-(--line) bg-(--surface-2) px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">Modo inteligente</p>
                        <p className="text-xs text-(--muted-fg) mt-0.5">
                          Transcripcion + deteccion de escenas + re-ranking LLM.
                        </p>
                      </div>
                      <Switch checked={smartMode} onCheckedChange={setSmartMode} />
                    </div>

                    <div className="flex items-center justify-between rounded-lg border border-(--line) bg-(--surface-2) px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">Split-screen</p>
                        <p className="text-xs text-(--muted-fg) mt-0.5">
                          Divide videos landscape en dos vistas apiladas (ideal para podcasts).
                        </p>
                      </div>
                      <Switch checked={splitScreen} onCheckedChange={setSplitScreen} />
                    </div>
                  </TabsContent>
                </Tabs>

                <Separator />

                <Button
                  type="submit"
                  disabled={!canSubmit}
                  size="lg"
                  className="w-full"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Procesando pipeline...
                    </>
                  ) : (
                    <>
                      <Cpu className="h-4 w-4" />
                      Generar {clipCount} clips virales
                    </>
                  )}
                </Button>

                {!canSubmit && !loading && (
                  <p className="text-center text-xs text-(--muted-fg)">
                    {!video
                      ? "Selecciona un video en la pestana Video para comenzar."
                      : backendReady === false
                        ? "Backend no disponible. Verifica FFmpeg y recarga la pagina."
                        : "Esperando disponibilidad del sistema."}
                  </p>
                )}
              </form>
            </CardContent>
          </Card>

          {/* Right — pipeline status */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Activity className="h-4 w-4 text-(--accent)" />
                  Estado del pipeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Status message */}
                <div className="rounded-lg border border-(--line) bg-(--surface-2) px-4 py-3 text-sm">
                  {processingStatus}
                </div>

                {/* Progress */}
                <div className="space-y-2">
                  <div className="flex justify-between text-xs font-mono text-(--muted-fg)">
                    <span>{progressStage}</span>
                    <span>{Math.round(progressValue)}%</span>
                  </div>
                  <Progress value={progressValue} />
                  {loading && (
                    <p className="text-xs text-(--muted-fg)">
                      {etaSeconds !== null
                        ? `ETA: ${formatSeconds(etaSeconds)}`
                        : "Procesando, esto puede tardar unos minutos..."}
                    </p>
                  )}
                </div>

                <Separator />

                {/* Feature indicators */}
                <div className="space-y-2 text-xs">
                  {[
                    { label: "Transcripcion Whisper-1", enabled: true },
                    { label: "Subtitulos karaoke", enabled: true },
                    { label: "Auto-titulo viral", enabled: autoTitle },
                    { label: "Filtro anti-publicidad", enabled: smartMode },
                    { label: "Corte por frase", enabled: smartMode },
                    { label: "Deteccion de escenas", enabled: true },
                    { label: "Re-ranking GPT-4o", enabled: smartMode },
                    { label: "Split-screen", enabled: splitScreen },
                  ].map(({ label, enabled }) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-(--muted-fg)">{label}</span>
                      <span
                        className={`font-mono font-medium ${
                          enabled ? "text-(--accent-2)" : "text-(--muted-fg)"
                        }`}
                      >
                        {enabled ? "activo" : "inactivo"}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Error card */}
            {error && (
              <Card className="border-red-500/30 bg-red-500/5">
                <CardContent className="pt-4">
                  <div className="flex gap-3">
                    <XCircle className="h-5 w-5 shrink-0 text-red-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-red-400">Error en el pipeline</p>
                      <p className="text-sm text-(--muted-fg) mt-1">{error}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Job diagnostics */}
            {response && (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-(--accent-2)" />
                    <CardTitle className="text-sm font-mono text-(--muted-fg)">
                      JOB {response.jobId}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {response.notes.map((note, i) => (
                    <p key={i} className="text-xs text-(--muted-fg) leading-5">
                      {note}
                    </p>
                  ))}
                </CardContent>
              </Card>
            )}

            {!error && !response && (
              <div className="rounded-xl border border-dashed border-(--line) p-6 text-center text-sm text-(--muted-fg)">
                Los clips apareceran aqui tras el procesamiento.
              </div>
            )}
          </div>
        </div>

        {/* Clips grid — full width */}
        {response && response.clips.length > 0 && (
          <section className="mt-10 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold">
                  {response.clips.length} clips listos
                </h2>
                <p className="text-sm text-(--muted-fg) mt-1">
                  Formato vertical 1080x1920 · optimizados para YouTube Shorts, TikTok e Instagram Reels
                </p>
              </div>
              <Badge variant="success" className="font-mono">
                {response.clips.filter((c) => c.hasSubtitles).length}/{response.clips.length} subtitulos
              </Badge>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {response.clips.map((clip, i) => (
                <div
                  key={clip.fileName}
                  className="group overflow-hidden rounded-xl border border-(--line) bg-(--surface) transition-all hover:border-(--line-2) hover:shadow-[0_0_0_1px_rgba(124,58,237,0.2)]"
                >
                  {/* 9:16 player */}
                  <div className="relative aspect-9/16 w-full bg-black">
                    <video
                      controls
                      preload="metadata"
                      className="absolute inset-0 h-full w-full object-contain"
                      src={clip.url}
                    />
                  </div>

                  {/* Metadata */}
                  <div className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-sm truncate" title={clip.title}>
                        {clip.title || `Clip ${i + 1}`}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {clip.hasSubtitles && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                            SUB
                          </Badge>
                        )}
                        {clip.score > 0 && (
                          <Badge variant="accent" className="font-mono text-[10px] py-0 px-1.5">
                            {clip.score.toFixed(0)}pts
                          </Badge>
                        )}
                      </div>
                    </div>

                    <p className="font-mono text-xs text-(--muted-fg)">
                      {clip.startSeconds.toFixed(1)}s &rarr;{" "}
                      {(clip.startSeconds + clip.durationSeconds).toFixed(1)}s
                      &nbsp;&middot;&nbsp;
                      {clip.durationSeconds.toFixed(1)}s
                    </p>

                    {clip.rationale && clip.rationale !== "corte uniforme" && (
                      <p className="text-xs text-(--muted-fg) leading-5 line-clamp-2">
                        {clip.rationale}
                      </p>
                    )}

                    <Button asChild variant="secondary" size="sm" className="w-full">
                      <a href={clip.url} download className="flex items-center gap-1.5">
                        <Download className="h-3.5 w-3.5" />
                        Descargar MP4
                      </a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
