// ---------------------------------------------------------------------------
// Caption Presets — Subtitle styles inspired by top viral content creators
// ---------------------------------------------------------------------------
// Each preset defines ASS (Advanced SubStation Alpha) style parameters that
// control how karaoke subtitles look. The highlight color is what the
// "active" word gets; the base color is for inactive words.
// ---------------------------------------------------------------------------

export type CaptionPreset = {
  id: string;
  name: string;
  description: string;
  /** ASS font name */
  fontName: string;
  /** Whether text is bold (-1 = bold, 0 = normal) */
  bold: string;
  /** Base text color (ASS BGR hex, e.g. &H00FFFFFF = white) */
  primaryColor: string;
  /** Highlight color for the active word (ASS BGR hex) */
  highlightColor: string;
  /** Outline color (ASS BGR hex) */
  outlineColor: string;
  /** Background/shadow color (ASS BGR hex) */
  backColor: string;
  /** BorderStyle: 1 = outline+shadow, 3 = opaque box */
  borderStyle: number;
  /** Outline thickness (scales with font size) */
  outlineScale: { small: number; medium: number; large: number };
  /** Shadow depth */
  shadowScale: { small: number; medium: number; large: number };
  /** Alignment: 2 = bottom-center, 5 = center, 8 = top-center */
  alignment: number;
  /** Vertical margin from bottom */
  marginV: number;
  /** Horizontal margin */
  marginH: number;
  /** Extra ASS override tags applied to each word (e.g. for glow effects) */
  activeWordTags: string;
  /** Tags for inactive words */
  inactiveWordTags: string;
  /** Words per line (affects pacing/readability) */
  wordsPerLine: number;
};

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

const HORMOZI: CaptionPreset = {
  id: "hormozi",
  name: "Hormozi",
  description: "Bold, clean, high-contrast. Yellow highlight on white text. Maximum readability.",
  fontName: "Arial Black",
  bold: "-1",
  primaryColor: "&H00FFFFFF",   // white
  highlightColor: "&H0000FFFF", // yellow (BGR)
  outlineColor: "&H00000000",   // black
  backColor: "&H80000000",      // semi-transparent black
  borderStyle: 1,
  outlineScale: { small: 4, medium: 5, large: 6 },
  shadowScale: { small: 2, medium: 2, large: 3 },
  alignment: 2,
  marginV: 220,
  marginH: 40,
  activeWordTags: "\\1c&H0000FFFF&\\b1",  // yellow + bold
  inactiveWordTags: "\\1c&H00FFFFFF&\\b1", // white + bold
  wordsPerLine: 3,
};

const MRBEAST: CaptionPreset = {
  id: "mrbeast",
  name: "MrBeast",
  description: "Massive, colorful, energetic. Red/green highlights. Maximum impact.",
  fontName: "Impact",
  bold: "-1",
  primaryColor: "&H00FFFFFF",   // white
  highlightColor: "&H000000FF", // red (BGR)
  outlineColor: "&H00000000",   // black
  backColor: "&HC0000000",      // darker shadow
  borderStyle: 1,
  outlineScale: { small: 5, medium: 6, large: 8 },
  shadowScale: { small: 3, medium: 4, large: 5 },
  alignment: 2,
  marginV: 200,
  marginH: 30,
  activeWordTags: "\\1c&H0000FF&\\b1\\fscx110\\fscy110", // red + slight scale up
  inactiveWordTags: "\\1c&H00FFFFFF&\\b1",
  wordsPerLine: 2, // fewer words = bigger visual impact
};

const CLASSIC: CaptionPreset = {
  id: "classic",
  name: "Clasico",
  description: "Subtitulos blancos con outline negro. Simple y profesional.",
  fontName: "Arial",
  bold: "-1",
  primaryColor: "&H00FFFFFF",
  highlightColor: "&H0000FFFF", // yellow
  outlineColor: "&H00000000",
  backColor: "&H80000000",
  borderStyle: 1,
  outlineScale: { small: 3, medium: 4, large: 5 },
  shadowScale: { small: 1, medium: 2, large: 2 },
  alignment: 2,
  marginV: 220,
  marginH: 40,
  activeWordTags: "\\1c&H0000FFFF&\\b1",
  inactiveWordTags: "\\1c&H00FFFFFF&\\b0",
  wordsPerLine: 4,
};

const NEON: CaptionPreset = {
  id: "neon",
  name: "Neon",
  description: "Efecto neon brillante. Cyan highlight con glow. Estilo gaming/tech.",
  fontName: "Arial Black",
  bold: "-1",
  primaryColor: "&H00FFFFFF",
  highlightColor: "&H00FFFF00", // cyan (BGR)
  outlineColor: "&H00FF8800",   // blue-ish glow
  backColor: "&H00000000",
  borderStyle: 1,
  outlineScale: { small: 4, medium: 5, large: 7 },
  shadowScale: { small: 3, medium: 4, large: 5 },
  alignment: 2,
  marginV: 220,
  marginH: 40,
  activeWordTags: "\\1c&H00FFFF00&\\3c&H00FFAA00&\\b1", // cyan text + blue outline glow
  inactiveWordTags: "\\1c&H00FFFFFF&\\3c&H00FF8800&\\b1",
  wordsPerLine: 3,
};

const MINIMAL: CaptionPreset = {
  id: "minimal",
  name: "Minimal",
  description: "Limpio y discreto. Texto pequeno, fondo semi-transparente. No distrae.",
  fontName: "Arial",
  bold: "0",
  primaryColor: "&H00FFFFFF",
  highlightColor: "&H0000CCFF", // orange-ish
  outlineColor: "&H00000000",
  backColor: "&HB0000000",      // darker background
  borderStyle: 3,               // opaque box style
  outlineScale: { small: 0, medium: 0, large: 0 },
  shadowScale: { small: 6, medium: 8, large: 10 }, // shadow = box padding in style 3
  alignment: 2,
  marginV: 240,
  marginH: 50,
  activeWordTags: "\\1c&H0000CCFF&",
  inactiveWordTags: "\\1c&H00FFFFFF&",
  wordsPerLine: 4,
};

const KARAOKE_POP: CaptionPreset = {
  id: "karaoke-pop",
  name: "Karaoke Pop",
  description: "Estilo karaoke con pop de escala. La palabra activa crece. Ideal para musica y reacciones.",
  fontName: "Arial Black",
  bold: "-1",
  primaryColor: "&H00FFFFFF",
  highlightColor: "&H0000FF00", // green (BGR)
  outlineColor: "&H00000000",
  backColor: "&H80000000",
  borderStyle: 1,
  outlineScale: { small: 4, medium: 5, large: 6 },
  shadowScale: { small: 2, medium: 3, large: 3 },
  alignment: 2,
  marginV: 210,
  marginH: 40,
  activeWordTags: "\\1c&H0000FF00&\\b1\\fscx120\\fscy120", // green + 120% scale
  inactiveWordTags: "\\1c&H00FFFFFF&\\b1\\fscx100\\fscy100",
  wordsPerLine: 3,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const CAPTION_PRESETS: CaptionPreset[] = [
  HORMOZI,
  MRBEAST,
  CLASSIC,
  NEON,
  MINIMAL,
  KARAOKE_POP,
];

export const DEFAULT_PRESET_ID = "hormozi";

export function getPreset(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((p) => p.id === id) ?? HORMOZI;
}

// ---------------------------------------------------------------------------
// ASS generation using presets
// ---------------------------------------------------------------------------

function assTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function getOutlineForSize(preset: CaptionPreset, fontSize: number): number {
  if (fontSize >= 44) return preset.outlineScale.large;
  if (fontSize >= 36) return preset.outlineScale.medium;
  return preset.outlineScale.small;
}

function getShadowForSize(preset: CaptionPreset, fontSize: number): number {
  if (fontSize >= 44) return preset.shadowScale.large;
  if (fontSize >= 36) return preset.shadowScale.medium;
  return preset.shadowScale.small;
}

export function buildPresetAssStyle(preset: CaptionPreset, fontSize: number): string {
  return [
    "Default",
    preset.fontName,
    String(fontSize),
    preset.primaryColor,
    "&H000000FF",
    preset.outlineColor,
    preset.backColor,
    preset.bold,
    "0",  // Italic
    "0",  // Underline
    "0",  // StrikeOut
    "100", // ScaleX
    "100", // ScaleY
    "0",   // Spacing
    "0",   // Angle
    String(preset.borderStyle),
    String(getOutlineForSize(preset, fontSize)),
    String(getShadowForSize(preset, fontSize)),
    String(preset.alignment),
    String(preset.marginH),
    String(preset.marginH),
    String(preset.marginV),
    "1",   // Encoding
  ].join(",");
}

export function buildPresetAssHeader(preset: CaptionPreset, fontSize: number): string {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${buildPresetAssStyle(preset, fontSize)}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");
}

export type WordTimestamp = { word: string; start: number; end: number };

// Max characters per subtitle line (like OpenShorts: prevents crowding)
const MAX_CHARS_PER_LINE = 22;
// Max duration per subtitle group (prevents reader overload)
const MAX_LINE_DURATION = 2.5;

/**
 * Group words into lines using smart grouping:
 * - Max characters per line (prevents text from going off-screen)
 * - Max duration per group (prevents reader fatigue)
 * - Preset wordsPerLine as hard cap
 * Inspired by OpenShorts' max_chars=20, max_duration=2.0 approach.
 */
function groupWordsIntoLines(words: WordTimestamp[], preset: CaptionPreset): WordTimestamp[][] {
  const lines: WordTimestamp[][] = [];
  let currentLine: WordTimestamp[] = [];
  let currentChars = 0;
  let lineStartTime = words[0]?.start ?? 0;

  for (const w of words) {
    const wordLen = w.word.length;
    const lineDuration = w.end - lineStartTime;

    const shouldBreak =
      currentLine.length >= preset.wordsPerLine ||
      (currentChars + wordLen + 1 > MAX_CHARS_PER_LINE && currentLine.length > 0) ||
      (lineDuration > MAX_LINE_DURATION && currentLine.length > 0);

    if (shouldBreak) {
      lines.push(currentLine);
      currentLine = [];
      currentChars = 0;
      lineStartTime = w.start;
    }

    currentLine.push(w);
    currentChars += wordLen + (currentLine.length > 1 ? 1 : 0); // +1 for space
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Generate karaoke ASS subtitles using a caption preset.
 * Each word gets highlighted with the preset's active style when spoken.
 * Uses smart grouping (chars + duration) instead of fixed word count.
 */
export function wordsToPresetAss(
  words: WordTimestamp[],
  fontSize: number,
  preset: CaptionPreset,
): string {
  if (words.length === 0) return "";

  const lines = groupWordsIntoLines(words, preset);

  const dialogues: string[] = [];

  for (const line of lines) {
    const lineEnd = line[line.length - 1].end;

    for (let wi = 0; wi < line.length; wi++) {
      const w = line[wi];
      const wordStart = w.start;
      const wordEnd = wi < line.length - 1 ? line[wi + 1].start : lineEnd;

      const parts = line.map((lw, li) => {
        const clean = lw.word.replace(/\\/g, "").toUpperCase();
        if (li === wi) {
          return `{${preset.activeWordTags}}${clean}{${preset.inactiveWordTags}}`;
        }
        return clean;
      });

      dialogues.push(
        `Dialogue: 0,${assTime(wordStart)},${assTime(wordEnd)},Default,,0,0,0,,${parts.join(" ")}`,
      );
    }
  }

  return `${buildPresetAssHeader(preset, fontSize)}\n${dialogues.join("\n")}\n`;
}

/**
 * Convert SRT subtitles to ASS using a caption preset (fallback when no word timestamps).
 */
export function srtToPresetAss(srt: string, fontSize: number, preset: CaptionPreset): string {
  const blocks = srt.trim().split(/\r?\n\r?\n+/);
  const dialogues: string[] = [];

  for (const block of blocks) {
    const blockLines = block.trim().split(/\r?\n/);
    if (blockLines.length < 3) continue;

    const timeMatch = blockLines[1]?.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!timeMatch) continue;

    const start = srtTimeToAss(timeMatch[1]);
    const end = srtTimeToAss(timeMatch[2]);
    const text = blockLines.slice(2).join("\\N").toUpperCase();

    dialogues.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
  }

  return `${buildPresetAssHeader(preset, fontSize)}\n${dialogues.join("\n")}\n`;
}

function srtTimeToAss(srtTime: string): string {
  const m = srtTime.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return "0:00:00.00";
  return `${parseInt(m[1])}:${m[2]}:${m[3]}.${m[4].slice(0, 2)}`;
}
