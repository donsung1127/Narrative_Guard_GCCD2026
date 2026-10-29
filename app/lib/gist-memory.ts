import type { GameState } from '@/app/lib/narrative-state';
import type { XmlLine } from '@/app/types';

/** Gist Memory is derived narrative context. It never overrides GameState or the event/state history. */
export type GistEpisode = {
  id: string;
  sceneId: string;
  summary: string;
  keyEvents: string[];
  relationshipChanges: string[];
  openThreads: string[];
  sourceStartLine: number;
  sourceEndLine: number;
  createdAt: string;
};

export type GistMemory = {
  version: 1;
  episodes: GistEpisode[];
  lastProcessedLineCount: number;
  lastSceneId?: string;
};

export const GIST_TRIGGER_LINE_INTERVAL = 10; // 대략 플레이어/응답 5턴
export const GIST_RECENT_RAW_LINE_COUNT = 10; // 최근 3~5턴에 해당하는 원본 대사 범위

export function emptyGistMemory(): GistMemory {
  return { version: 1, episodes: [], lastProcessedLineCount: 0 };
}

export function normalizeGistMemory(raw: unknown): GistMemory {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyGistMemory();
  const value = raw as Record<string, unknown>;
  const episodes = Array.isArray(value.episodes) ? value.episodes.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const e = entry as Record<string, unknown>;
    const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 12) : [];
    if (typeof e.summary !== 'string' || !e.summary.trim()) return [];
    return [{
      id: typeof e.id === 'string' ? e.id : `gist-${index}`,
      sceneId: typeof e.sceneId === 'string' ? e.sceneId : '',
      summary: e.summary.trim().slice(0, 1800),
      keyEvents: strings(e.keyEvents),
      relationshipChanges: strings(e.relationshipChanges),
      openThreads: strings(e.openThreads),
      sourceStartLine: Number.isInteger(e.sourceStartLine) ? Number(e.sourceStartLine) : 0,
      sourceEndLine: Number.isInteger(e.sourceEndLine) ? Number(e.sourceEndLine) : 0,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date(0).toISOString(),
    }];
  }).slice(-50) : [];
  return {
    version: 1,
    episodes,
    lastProcessedLineCount: Number.isInteger(value.lastProcessedLineCount) && Number(value.lastProcessedLineCount) >= 0 ? Number(value.lastProcessedLineCount) : 0,
    ...(typeof value.lastSceneId === 'string' ? { lastSceneId: value.lastSceneId } : {}),
  };
}

export function shouldCreateGist(memoryRaw: unknown, lineCountAfterGeneration: number, currentSceneId: string): boolean {
  const memory = normalizeGistMemory(memoryRaw);
  const sceneChanged = !!memory.lastSceneId && memory.lastSceneId !== currentSceneId;
  const enoughNewLines = lineCountAfterGeneration - memory.lastProcessedLineCount >= GIST_TRIGGER_LINE_INTERVAL;
  return sceneChanged || enoughNewLines;
}

export function buildGistContext(memoryRaw: unknown, recentLines: XmlLine[], state: GameState): string {
  const memory = normalizeGistMemory(memoryRaw);
  const gistText = memory.episodes.length
    ? JSON.stringify(memory.episodes, null, 2)
    : '(아직 생성된 에피소드 요약이 없음)';
  const rawText = recentLines.slice(-GIST_RECENT_RAW_LINE_COUNT).map((line, i) => {
    const role = line.role === 'user' ? 'PLAYER' : 'NARRATOR/NPC';
    return `${i + 1}. [${role}] ${line.text}`;
  }).join('\n');
  return `

--- GIST MEMORY (DERIVED CONTEXT; NOT AUTHORITATIVE STATE) ---
${gistText}

--- RECENT RAW DIALOGUE (LAST ${GIST_RECENT_RAW_LINE_COUNT} LINES) ---
${rawText || '(대사 없음)'}

--- CURRENT AUTHORITATIVE GAME STATE ---
${JSON.stringify(state)}

Memory rules: use Gist Memory for long-range narrative continuity, character relationship changes, and unresolved threads. Recent raw dialogue is more precise for immediate context. The current GameState and validated state history are the only authority for location, health, gold, and inventory. If a gist conflicts with GameState, follow GameState. Do not treat a summary as proof that an item or event currently exists.`;
}

export function buildGistGenerationPrompt(args: {
  sceneId: string;
  lineCount: number;
  startLine: number;
  recentLines: XmlLine[];
  previousMemory: GistMemory;
  language: string;
}): string {
  const raw = args.recentLines.slice(-GIST_RECENT_RAW_LINE_COUNT).map((line) => `${line.role === 'user' ? 'PLAYER' : 'NARRATOR/NPC'}: ${line.text}`).join('\n');
  const previous = args.previousMemory.episodes.slice(-8).map((e) => ({ summary: e.summary, keyEvents: e.keyEvents, relationshipChanges: e.relationshipChanges, openThreads: e.openThreads }));
  return `Create one compact episode gist for a narrative game. Write all natural-language values in ${args.language || 'the same language as the dialogue'}. Preserve only events supported by the raw dialogue. Focus on key events, relationship changes, character motivations, and unresolved plot threads. Do not invent facts. Do not infer current inventory, gold, health, or location from dialogue. This gist is secondary memory, not authoritative game state.

Current scene ID: ${args.sceneId}
Source line range: ${args.startLine}-${args.lineCount - 1}
Previous episode gists (for continuity; do not duplicate them verbatim): ${JSON.stringify(previous)}

Recent raw dialogue:
${raw}

Return ONLY valid JSON with this exact shape:
{"summary":"short episode summary","keyEvents":["..."],"relationshipChanges":["..."],"openThreads":["..."]}
Limits: summary <= 900 characters; each array <= 8 entries; each entry <= 220 characters. If there are no relationship changes or open threads, return an empty array.`;
}

export function parseGistPayload(text: string): { summary: string; keyEvents: string[]; relationshipChanges: string[]; openThreads: string[] } | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return undefined;
  try {
    const value = JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
    if (typeof value.summary !== 'string' || !value.summary.trim()) return undefined;
    const toStrings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8).map((x) => x.slice(0, 220)) : [];
    return { summary: value.summary.trim().slice(0, 900), keyEvents: toStrings(value.keyEvents), relationshipChanges: toStrings(value.relationshipChanges), openThreads: toStrings(value.openThreads) };
  } catch { return undefined; }
}
