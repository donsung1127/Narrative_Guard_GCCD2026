import { ApiLine, END_SCENE_ID, XmlLine } from '@/app/types';
import { StepApiInputType, StepApiOutputType } from '@/utils/api/types';
import { convertDisplayLineToXmlLines } from '@/utils/convert';
import { getScene } from '@/utils/game';
import { getSceneTransitionLines } from '@/utils/lines';
import { callAnthropicAPI } from '../../utils';
import { parseXmlFormat } from './parse';
import { getSystemPrompt, getUserPrompt } from './prompt';
import { getInitialGameState, normalizeGameState, verifyStateHistory, type StateHistoryEntry } from '@/app/lib/narrative-state';
import { buildGistContext, buildGistGenerationPrompt, emptyGistMemory, normalizeGistMemory, parseGistPayload, shouldCreateGist, type GistMemory } from '@/app/lib/gist-memory';

export async function generateNextLines(input: StepApiInputType): Promise<StepApiOutputType> {
  try {
    const { project, playthrough, triggers } = input;
    const { scenes } = project.cartridge;
    const { lines: displayLines, currentSceneId } = playthrough;
    const previousLines = convertDisplayLineToXmlLines(displayLines, scenes);
    const scene = getScene({ cartridge: { scenes } }, currentSceneId);
    const scenePlace = project.cartridge.places.find((place) => place.uuid === scene.placeId);
    const previousStateLine = [...displayLines].reverse().find((line) => line.metadata?.narrativeHistory || line.metadata?.narrativeState);
    const initialState = getInitialGameState(project, scenePlace?.name ?? '알 수 없음');
    const history = previousStateLine?.metadata?.narrativeHistory as StateHistoryEntry[] | undefined;
    const historyIntegrity = history ? await verifyStateHistory(history) : { valid: false, reason: 'no previous state history' };
    const historyState = historyIntegrity.valid && history?.length ? history[history.length - 1].state : undefined;
    const currentState = normalizeGameState(historyState ?? initialState, scenePlace?.name ?? '알 수 없음');
    const previousGistLine = [...displayLines].reverse().find((line) => line.metadata?.gistMemory);
    let gistMemory: GistMemory = normalizeGistMemory(previousGistLine?.metadata?.gistMemory ?? { ...emptyGistMemory(), lastSceneId: currentSceneId });
    const recentDialogue = previousLines.slice(-10);

    // Get the first goToSceneId; prioritize action triggers over fallback triggers
    let eventTrigger = triggers.find((t) => t.goToSceneId !== undefined && t.type === 'action');
    if (!eventTrigger) {
      eventTrigger = triggers.find((t) => t.goToSceneId !== undefined);
    }
    if (!eventTrigger) {
      eventTrigger = triggers[0];
    }
    const { endingName, goToSceneId } = eventTrigger || {};
    const triggerNarratives = triggers.map((t) => t.narrative);
    const systemPrompt = getSystemPrompt({
      project,
      scene,
      goToSceneId,
      currentState,
    }) + buildGistContext(gistMemory, recentDialogue, currentState);

    const apiLines: ApiLine[] = previousLines.map((line) => ({
      role: line.role,
      content: [
        {
          type: 'text',
          text: `PLAN: ${line.metadata?.plan}\nLINE: ${line.text}\nPAUSE: ${line.metadata?.shouldPause}`,
        },
      ],
    }));

    const text = await callAnthropicAPI(
      systemPrompt,
      [
        ...apiLines,
        {
          role: 'user' as const,
          content: getUserPrompt({
            project,
            scene,
            goToSceneId,
            triggerNarratives,
            previousLines,
            currentState,
          }),
        },
      ] as ApiLine[],
      // {
      //   temperature: 0.5,
      // },
    );
    console.log(
      '\n\n--- Generated line ---\n',
      previousLines[previousLines.length - 1].text,
      text,
      '\n\n',
    );

    // Parse the response into PLAN:/LINE:/PAUSE:/END: sections
    const { plan, lineContent, shouldPause, stateChange } = parseXmlFormat(text);

    // Store the response in XML format
    const lines: XmlLine[] = [
      {
        role: 'assistant',
        text: lineContent,
        metadata: {
          plan,
          shouldPause,
        },
      },
    ];

    if (lines.length === 0) {
      throw new Error('No lines generated');
    }

    // Handle end/scene transitions
    if (goToSceneId === END_SCENE_ID) {
      lines.push({
        role: 'assistant',
        text: `END: ${endingName || 'Game Over'}`,
        metadata: { shouldEnd: true, endingName },
      });
    } else if (goToSceneId !== undefined) {
      const newScene = getScene({ cartridge: { scenes } }, goToSceneId);
      const sceneTransitionLines = await getSceneTransitionLines({
        newScene,
      });
      sceneTransitionLines.forEach((line) => {
        lines.push({
          role: 'assistant',
          text: line.text,
          metadata: line.metadata,
        });
      });
    }

    // Gisting is triggered after enough new dialogue (about five player/response turns)
    // or when the scene changes. A failed gist call never blocks story generation.
    const generatedLineCount = displayLines.length + lines.length;
    if (shouldCreateGist(gistMemory, generatedLineCount, currentSceneId)) {
      const startLine = Math.min(gistMemory.lastProcessedLineCount, Math.max(0, generatedLineCount - 10));
      const sourceLines = [...previousLines, ...lines];
      try {
        const gistPrompt = buildGistGenerationPrompt({
          sceneId: currentSceneId,
          lineCount: sourceLines.length,
          startLine,
          recentLines: sourceLines.slice(-10),
          previousMemory: gistMemory,
          language: input.language,
        });
        const gistText = await callAnthropicAPI(
          'You are a careful narrative-memory summarizer. Return only valid JSON; never create game-state changes.',
          [{ role: 'user', content: [{ type: 'text', text: gistPrompt }] }] as ApiLine[],
        );
        const parsedGist = parseGistPayload(gistText);
        if (parsedGist) {
          gistMemory = normalizeGistMemory({
            ...gistMemory,
            episodes: [...gistMemory.episodes, {
              id: `gist-${generatedLineCount}-${Date.now()}`,
              sceneId: currentSceneId,
              ...parsedGist,
              sourceStartLine: startLine,
              sourceEndLine: Math.max(0, generatedLineCount - 1),
              createdAt: new Date().toISOString(),
            }],
            lastProcessedLineCount: generatedLineCount,
            lastSceneId: currentSceneId,
          });
        } else {
          console.warn('Gist Memory response was not valid JSON; retaining previous memory.');
        }
      } catch (gistError) {
        console.warn('Gist Memory update failed; continuing without blocking the story:', gistError);
      }
    }

    return {
      lines,
      stateChange,
      gistMemory,
    };
  } catch (error) {
    console.error('Error in generateNextLines:', error);
    return {
      lines: [],
    };
  }
}
