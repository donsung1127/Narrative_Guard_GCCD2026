import type { GameState } from '@/app/lib/narrative-state';
import type { XmlLine } from '@/app/types';

/** Gist Memory is derived narrative context. It never overrides GameState or the event/state history. */
export type GistEpisode = {
  id: string;
  sceneId: string;
  summary: string;
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
    if (typeof e.summary !== 'string' || !e.summary.trim()) return [];

    return [{
      id: typeof e.id === 'string' ? e.id : `gist-${index}`,
      sceneId: typeof e.sceneId === 'string' ? e.sceneId : '',
      summary: e.summary.trim().slice(0, 1800),
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
    ? memory.episodes.map((ep, idx) => {
        const sceneLabel = ep.sceneId ? ` [Scene: ${ep.sceneId}]` : '';
        return `[Episode ${idx + 1}${sceneLabel} | Lines ${ep.sourceStartLine}-${ep.sourceEndLine}]\n${ep.summary}`;
      }).join('\n\n')
    : '(아직 생성된 에피소드 요약이 없음)';

  const rawText = recentLines.slice(-GIST_RECENT_RAW_LINE_COUNT).map((line, i) => {
    const role = line.role === 'user' ? 'PLAYER' : 'NARRATOR/NPC';
    return `${i + 1}. [${role}] ${line.text}`;
  }).join('\n');

  return `

--- GIST MEMORY (SHORTENED EPISODE SUMMARIES; NOT AUTHORITATIVE STATE) ---
${gistText}

--- RECENT RAW DIALOGUE (LAST ${GIST_RECENT_RAW_LINE_COUNT} LINES) ---
${rawText || '(대사 없음)'}

--- CURRENT AUTHORITATIVE GAME STATE ---
${JSON.stringify(state)}

Memory rules: use Gist Memory for long-range narrative continuity and character relationship shifts. Recent raw dialogue is more precise for immediate context. The current GameState and validated state history are the only authority for location, health, gold, and inventory. If a gist conflicts with GameState, follow GameState. Do not treat a summary as proof that an item or event currently exists.`;
}

export function buildGistGenerationPrompt(args: {
  sceneId: string;
  lineCount: number;
  startLine: number;
  recentLines: XmlLine[];
  previousMemory: GistMemory;
  language: string;
}): string {
  const raw = args.recentLines
    .slice(-GIST_RECENT_RAW_LINE_COUNT)
    .map((line) => `${line.role === 'user' ? 'PLAYER' : 'NARRATOR/NPC'}: ${line.text}`)
    .join('\n');

  const previous = args.previousMemory.episodes
    .slice(-8)
    .map((e, i) => `[Episode ${i + 1}] ${e.summary}`)
    .join('\n');

  return `You are a narrative editor shortening a specific dialogue segment of an interactive story into a single, cohesive prose summary.
Write the summary in ${args.language || 'the same language as the dialogue'}.

### Core Compression Rules (Shorten, Don't Tag):
1. **Single Cohesive Paragraph**: Condense the dialogue segment into a tight 2–4 sentence narrative summary. Do NOT use bullet points, keyword lists, parenthetical notes, or separate metadata labels.
2. **Embed Key Events & Relationship Shifts**: Naturally weave *what key actions/events occurred* and *how character attitudes, trust, or relationships changed* into the narrative flow with clear cause-and-effect, while trimming filler words and redundant descriptions.
3. **STRICT NO-PREDICTION / FACT-ONLY RULE**:
   - Summarize **ONLY** actions, statements, and reactions that explicitly occurred within the provided dialogue lines.
   - **NEVER** predict, suggest, or speculate about what the player or characters should do next, what will happen in the future, or unresolved future plans (e.g., do NOT write "The player must now find...", "Next, they will...", or "It remains to be seen..."). End the summary strictly at the last actual event of the segment.
4. **State & Continuity Grounding**:
   - Do not invent facts or infer authoritative game state (exact gold, HP, inventory items, or coordinates).
   - Maintain continuity with previous episode summaries without repeating events already covered in them.

Current scene ID: ${args.sceneId}
Source line range: ${args.startLine}-${args.lineCount - 1}

Previous episode summaries (for continuity only; do not duplicate):
${previous || '(None)'}

Dialogue segment to shorten:
${raw}

Return ONLY valid JSON with this exact shape:
{"summary":"shortened factual narrative paragraph"}
Limit: summary <= 900 characters.`;
}

export function parseGistPayload(text: string): { summary: string } | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return undefined;
  try {
    const value = JSON.parse(cleaned.slice(first, last + 1)) as Record<string, unknown>;
    if (typeof value.summary !== 'string' || !value.summary.trim()) return undefined;
    return {
      summary: value.summary.trim().replace(/\s+/g, ' ').slice(0, 900),
    };
  } catch {
    return undefined;
  }
}