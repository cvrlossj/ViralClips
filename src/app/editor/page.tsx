"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  Loader2,
  Play,
  Pause,
  RotateCcw,
  Scissors,
  Share2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ClipScores = {
  hook: number;
  flow: number;
  engagement: number;
  completeness: number;
};

type ClipResult = {
  fileName: string;
  url: string;
  startSeconds: number;
  durationSeconds: number;
  hasSubtitles: boolean;
  scores: ClipScores;
  overallScore: number;
  rationale: string;
  title: string;
  hookText?: string;
  descriptions?: { tiktok: string; instagram: string; youtube: string };
  thumbnailUrl?: string;
  hookApplied?: boolean;
};

type JobManifest = {
  jobId: string;
  sourceVideoPath: string;
  sourceFileName: string;
  clips: ClipResult[];
  words: { word: string; start: number; end: number }[];
  visualAnalysis?: {
    summary: string;
    hotSpots: { start: number; end: number; reason: string }[];
    signalCount: number;
  };
  settings: {
    splitScreen: boolean;
    hookOptimizer?: boolean;
    watermarkImage?: string;
    sourceCropFilter?: string;
  };
  notes: string[];
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <div className="grain flex min-h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-(--accent)" />
        </div>
      }
    >
      <EditorContent />
    </Suspense>
  );
}

function EditorContent() {
  const searchParams = useSearchParams();
  const jobId = searchParams.get("jobId");

  const [manifest, setManifest] = useState<JobManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeClipIdx, setActiveClipIdx] = useState(0);

  // Edit state
  const [editStart, setEditStart] = useState(0);
  const [editDuration, setEditDuration] = useState(0);

  // Playback
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  // Rerender
  const [rerendering, setRerendering] = useState(false);
  const [rerenderMsg, setRerenderMsg] = useState("");

  // ---------------------------------------------------------------------------
  // Sync edit fields when clip changes
  // ---------------------------------------------------------------------------

  const syncEditState = useCallback((m: JobManifest, idx: number) => {
    const clip = m.clips[idx];
    if (!clip) return;
    setEditStart(clip.startSeconds);
    setEditDuration(clip.durationSeconds);
  }, []);

  // ---------------------------------------------------------------------------
  // Load manifest
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!jobId) {
      setError("No se especifico jobId en la URL.");
      setLoading(false);
      return;
    }

    fetch(`/api/job/${encodeURIComponent(jobId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Job no encontrado.");
        return res.json() as Promise<JobManifest>;
      })
      .then((data) => {
        setManifest(data);
        if (data.clips.length > 0) {
          syncEditState(data, 0);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [jobId, syncEditState]);

  const selectClip = useCallback(
    (idx: number) => {
      if (!manifest) return;
      setActiveClipIdx(idx);
      syncEditState(manifest, idx);
      setRerenderMsg("");
      setIsPlaying(false);
    },
    [manifest, syncEditState],
  );

  // ---------------------------------------------------------------------------
  // Video playback
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onEnded = () => setIsPlaying(false);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
    };
  }, [activeClipIdx]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Re-render
  // ---------------------------------------------------------------------------

  const handleRerender = async () => {
    if (!manifest) return;
    setRerendering(true);
    setRerenderMsg("");

    try {
      const res = await fetch("/api/rerender", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: manifest.jobId,
          clipIndex: activeClipIdx,
          start: editStart,
          duration: editDuration,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Error desconocido" }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      // Update manifest locally
      const updated = { ...manifest };
      updated.clips = [...updated.clips];
      updated.clips[activeClipIdx] = data.clip;
      setManifest(updated);
      setRerenderMsg("Clip re-renderizado correctamente.");

      // Force video reload
      if (videoRef.current) {
        videoRef.current.load();
      }
    } catch (err) {
      setRerenderMsg(
        err instanceof Error ? err.message : "Error re-renderizando.",
      );
    } finally {
      setRerendering(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const activeClip = manifest?.clips[activeClipIdx] ?? null;
  const clipVideoUrl = activeClip
    ? `/api/preview/${encodeURIComponent(activeClip.fileName)}`
    : "";

  const hasChanges =
    manifest &&
    activeClip &&
    (editStart !== activeClip.startSeconds ||
      editDuration !== activeClip.durationSeconds);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="grain flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-(--accent)" />
      </div>
    );
  }

  if (error || !manifest) {
    return (
      <div className="grain flex min-h-screen items-center justify-center">
        <Card className="max-w-md bg-(--surface) border-(--line)">
          <CardContent className="pt-6 text-center">
            <p className="text-(--muted-fg)">{error || "Job no encontrado."}</p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => (window.location.href = "/")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Volver
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grain min-h-screen">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-(--line) px-6 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (window.history.length > 1) window.history.back();
            else window.location.href = "/";
          }}
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Volver
        </Button>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold truncate">
            {manifest.sourceFileName}
          </h1>
          <p className="text-xs text-(--muted-fg)">
            Job: {manifest.jobId} · {manifest.clips.length} clips
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              manifest.clips.forEach((clip) => {
                const a = document.createElement("a");
                a.href = clip.url;
                a.download = clip.fileName;
                a.click();
              });
            }}
          >
            <Download className="mr-1 h-3.5 w-3.5" /> Descargar todos
          </Button>
        </div>
      </header>

      {/* Clip strip — horizontal scrollable */}
      <div className="border-b border-(--line) bg-(--surface)">
        <div className="flex items-center gap-2 overflow-x-auto px-4 py-3 scrollbar-thin">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            disabled={activeClipIdx <= 0}
            onClick={() => selectClip(activeClipIdx - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          {manifest.clips.map((clip, idx) => (
            <button
              key={idx}
              onClick={() => selectClip(idx)}
              className={`shrink-0 rounded-lg border px-3 py-2 text-left transition-all ${
                idx === activeClipIdx
                  ? "border-(--accent) bg-(--accent)/10 ring-1 ring-(--accent)/30"
                  : "border-(--line) bg-(--surface-2) hover:border-(--line-2)"
              }`}
              style={{ minWidth: 160 }}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-(--muted-fg)">
                  #{idx + 1}
                </span>
                {clip.overallScore > 0 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 border-(--accent)/40 text-(--accent)"
                  >
                    {clip.overallScore}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs truncate max-w-[140px]">
                Clip #{idx + 1}
              </p>
              <p className="text-[10px] text-(--muted-fg) mt-0.5">
                {formatTime(clip.startSeconds)} — {formatTime(clip.startSeconds + clip.durationSeconds)}
              </p>
            </button>
          ))}

          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            disabled={activeClipIdx >= manifest.clips.length - 1}
            onClick={() => selectClip(activeClipIdx + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Visual timeline */}
      <div className="border-b border-(--line) bg-(--surface) px-4 py-2">
        <div className="relative h-8 rounded-md bg-(--surface-2) overflow-hidden">
          {(() => {
            // Estimate total duration from the latest clip end time
            const maxEnd = manifest.clips.reduce(
              (max, c) => Math.max(max, c.startSeconds + c.durationSeconds),
              0,
            );
            const totalDuration = Math.max(maxEnd * 1.05, 60);

            return manifest.clips.map((clip, idx) => {
              const left = (clip.startSeconds / totalDuration) * 100;
              const width = Math.max((clip.durationSeconds / totalDuration) * 100, 1);
              const isActive = idx === activeClipIdx;

              return (
                <button
                  key={idx}
                  className={`absolute top-1 bottom-1 rounded transition-all cursor-pointer ${
                    isActive
                      ? "bg-(--accent) ring-2 ring-(--accent)/50 z-10"
                      : "bg-(--accent)/30 hover:bg-(--accent)/50"
                  }`}
                  style={{ left: `${left}%`, width: `${width}%`, minWidth: 6 }}
                  onClick={() => selectClip(idx)}
                  title={`#${idx + 1}: ${formatTime(clip.startSeconds)} — ${formatTime(clip.startSeconds + clip.durationSeconds)} (${clip.durationSeconds.toFixed(0)}s)`}
                />
              );
            });
          })()}
          {/* Visual hot spots overlay */}
          {manifest.visualAnalysis?.hotSpots.map((hs, i) => {
            const maxEnd = manifest.clips.reduce(
              (max, c) => Math.max(max, c.startSeconds + c.durationSeconds),
              0,
            );
            const totalDuration = Math.max(maxEnd * 1.05, 60);
            const left = (hs.start / totalDuration) * 100;
            const width = Math.max(((hs.end - hs.start) / totalDuration) * 100, 0.5);
            return (
              <div
                key={`hs-${i}`}
                className="absolute top-0 bottom-0 bg-yellow-400/15 border-x border-yellow-400/30 pointer-events-none"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`Hot spot: ${hs.reason}`}
              />
            );
          })}
          {/* Time markers */}
          <div className="absolute inset-0 flex items-end justify-between px-1 pointer-events-none">
            <span className="text-[9px] text-(--muted-fg)/50">0:00</span>
            <span className="text-[9px] text-(--muted-fg)/50">
              {formatTime(
                manifest.clips.reduce(
                  (max, c) => Math.max(max, c.startSeconds + c.durationSeconds),
                  0,
                ),
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Main editor area */}
      <div className="flex flex-col lg:flex-row gap-0 lg:gap-0 flex-1">
        {/* Left — Video preview */}
        <div className="lg:w-[58%] flex flex-col items-center justify-center p-4 lg:p-6">
          <div
            className="relative bg-black rounded-xl overflow-hidden shadow-2xl"
            style={{ aspectRatio: "9/16", maxHeight: "70vh", width: "auto" }}
          >
            {activeClip && (
              <video
                ref={videoRef}
                key={`${activeClip.fileName}-${activeClip.startSeconds}`}
                className="h-full w-full object-cover"
                src={clipVideoUrl}
                playsInline
              />
            )}
          </div>

          {/* Playback controls */}
          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              onClick={togglePlay}
              className="h-9 w-9"
            >
              {isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
            <span className="text-xs font-mono text-(--muted-fg) tabular-nums">
              {formatTime(currentTime)} / {formatTime(activeClip?.durationSeconds ?? 0)}
            </span>
            {activeClip && (
              <a
                href={activeClip.url}
                download
                className="ml-2"
              >
                <Button variant="outline" size="sm">
                  <Download className="mr-1 h-3.5 w-3.5" /> Descargar
                </Button>
              </a>
            )}
          </div>
        </div>

        {/* Right — Edit panels */}
        <div className="lg:w-[42%] border-l border-(--line) bg-(--surface) overflow-y-auto">
          {/* AI Analysis card */}
          {activeClip && (
            <div className="border-b border-(--line) px-5 py-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-(--muted-fg) mb-2">
                Analisis IA
              </h3>
              <div className="flex items-center gap-2 mb-2">
                <Badge className="bg-(--accent)/15 text-(--accent) border-0">
                  {activeClip.overallScore}/100
                </Badge>
                <span className="text-xs text-(--muted-fg)">
                  {formatTime(activeClip.startSeconds)} — {formatTime(activeClip.startSeconds + activeClip.durationSeconds)}
                  {" · "}{activeClip.durationSeconds.toFixed(0)}s
                </span>
              </div>
              {activeClip.overallScore > 0 && (
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {(
                    [
                      { key: "hook" as const, label: "Hook" },
                      { key: "flow" as const, label: "Flow" },
                      { key: "engagement" as const, label: "Engage" },
                      { key: "completeness" as const, label: "Compl" },
                    ] as const
                  ).map(({ key, label }) => {
                    const v = activeClip.scores[key];
                    const grade =
                      v >= 90 ? "A+" : v >= 80 ? "A" : v >= 70 ? "B+" :
                      v >= 60 ? "B" : v >= 50 ? "C" : "D";
                    const color =
                      v >= 80 ? "text-(--accent-2)" : v >= 60 ? "text-yellow-400" : "text-red-400";
                    return (
                      <div key={key} className="text-center rounded-lg bg-(--surface-2) py-1.5">
                        <span className="text-[10px] text-(--muted-fg) block">{label}</span>
                        <span className={`font-mono font-bold text-sm ${color}`}>{grade}</span>
                        <span className="text-[10px] text-(--muted-fg) block">{v}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-(--muted-fg) leading-relaxed">
                {activeClip.rationale}
              </p>
            </div>
          )}

          {/* Visual analysis card */}
          {manifest.visualAnalysis && (
            <div className="border-b border-(--line) px-5 py-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-(--muted-fg) mb-2 flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" />
                Analisis visual
              </h3>
              <p className="text-xs text-(--muted-fg) leading-relaxed mb-2">
                {manifest.visualAnalysis.summary}
              </p>
              {manifest.visualAnalysis.hotSpots.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-(--muted-fg) uppercase tracking-wider">
                    Zonas calientes
                  </p>
                  {manifest.visualAnalysis.hotSpots.map((hs, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded-md bg-(--surface-2) px-3 py-1.5 text-xs"
                    >
                      <span className="font-mono text-(--accent) shrink-0">
                        {formatTime(hs.start)}-{formatTime(hs.end)}
                      </span>
                      <span className="text-(--muted-fg) truncate">{hs.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Edit tabs */}
          <Tabs defaultValue="trim" className="px-5 py-4">
            <TabsList className="w-full bg-(--surface-2)">
              <TabsTrigger value="trim" className="flex-1 text-xs">
                <Scissors className="mr-1 h-3.5 w-3.5" /> Trim
              </TabsTrigger>
              <TabsTrigger value="copys" className="flex-1 text-xs">
                <Share2 className="mr-1 h-3.5 w-3.5" /> Copys
              </TabsTrigger>
            </TabsList>

            {/* Tab: Trim */}
            <TabsContent value="trim" className="mt-4 space-y-4">
              <div>
                <Label className="text-xs text-(--muted-fg)">
                  Inicio (segundos en video original)
                </Label>
                <div className="mt-2 flex items-center gap-3">
                  <Input
                    type="number"
                    className="w-24 bg-(--surface-2) border-(--line) font-mono text-sm"
                    value={editStart.toFixed(1)}
                    onChange={(e) => setEditStart(Number(e.target.value))}
                    step={0.5}
                    min={0}
                  />
                  <span className="text-xs text-(--muted-fg)">
                    {formatTime(editStart)}
                  </span>
                </div>
              </div>

              <div>
                <Label className="text-xs text-(--muted-fg)">
                  Duracion (segundos)
                </Label>
                <Slider
                  className="mt-2"
                  min={5}
                  max={90}
                  step={1}
                  value={[editDuration]}
                  onValueChange={([v]) => setEditDuration(v)}
                />
                <div className="mt-1 flex justify-between text-[10px] text-(--muted-fg)">
                  <span>5s</span>
                  <span className="font-mono">{editDuration}s</span>
                  <span>90s</span>
                </div>
              </div>

              <div className="rounded-lg bg-(--surface-2) p-3 border border-(--line)">
                <p className="text-xs text-(--muted-fg)">Rango resultante</p>
                <p className="text-sm font-mono mt-1">
                  {formatTime(editStart)} — {formatTime(editStart + editDuration)}
                </p>
              </div>
            </TabsContent>

            {/* Tab: Platform Copys */}
            <TabsContent value="copys" className="mt-4 space-y-4">
              {activeClip?.hookText && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-yellow-700">
                      Hook Text Overlay
                    </span>
                  </div>
                  <p className="text-sm font-bold text-yellow-900">{activeClip.hookText}</p>
                </div>
              )}

              {activeClip?.descriptions ? (
                <div className="space-y-3">
                  {([
                    { key: "tiktok" as const, label: "TikTok", color: "text-black", bg: "bg-gray-50 border-gray-200" },
                    { key: "instagram" as const, label: "Instagram", color: "text-pink-600", bg: "bg-pink-50 border-pink-200" },
                    { key: "youtube" as const, label: "YouTube", color: "text-red-600", bg: "bg-red-50 border-red-200" },
                  ] as const).map(({ key, label, color, bg }) => {
                    const text = activeClip.descriptions?.[key];
                    if (!text) return null;
                    return (
                      <div key={key} className={`rounded-lg border p-3 ${bg}`}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>
                            {label}
                          </span>
                          <button
                            className="text-[10px] text-(--muted-fg) hover:text-(--foreground) flex items-center gap-1 transition-colors"
                            onClick={() => {
                              navigator.clipboard.writeText(text);
                            }}
                          >
                            <Copy className="h-3 w-3" /> Copiar
                          </button>
                        </div>
                        <p className="text-xs leading-relaxed text-(--foreground)">{text}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg bg-(--surface-2) border border-(--line) p-4 text-center">
                  <Share2 className="mx-auto h-8 w-8 text-(--muted-fg) mb-2" />
                  <p className="text-xs text-(--muted-fg)">
                    Sin descripciones generadas para este clip.
                  </p>
                </div>
              )}
            </TabsContent>
          </Tabs>

          {/* Re-render button */}
          <div className="border-t border-(--line) px-5 py-4">
            <Button
              className="w-full btn-glow bg-(--accent) hover:bg-(--accent-hover) text-(--accent-fg)"
              disabled={rerendering || !hasChanges}
              onClick={handleRerender}
            >
              {rerendering ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Re-renderizando...
                </>
              ) : (
                <>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Re-renderizar clip
                </>
              )}
            </Button>
            {!hasChanges && !rerendering && (
              <p className="mt-2 text-center text-[10px] text-(--muted-fg)">
                Modifica el trim para habilitar
              </p>
            )}
            {rerenderMsg && (
              <p
                className={`mt-2 text-center text-xs ${
                  rerenderMsg.includes("correctamente")
                    ? "text-(--accent-2)"
                    : "text-red-400"
                }`}
              >
                {rerenderMsg}
              </p>
            )}
          </div>

          {/* Notes */}
          <div className="border-t border-(--line) px-5 py-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-(--muted-fg) mb-2">
              Notas del pipeline
            </h3>
            <ul className="space-y-1">
              {manifest.notes.map((note, i) => (
                <li key={i} className="text-[11px] text-(--muted-fg) leading-relaxed">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
