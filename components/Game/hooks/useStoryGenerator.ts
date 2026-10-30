import { actionObserver } from '@/lib/action-interpreter/observer.mjs';
/* eslint-disable react-hooks/exhaustive-deps */
import { getBlankScene } from '@/app/constants';
import { DisplayLine, DisplayLineStatus, Playthrough, StoryState } from '@/app/types';
import { useToastStore } from '@/store/toast';
import { apiClient } from '@/utils/api';
import { LABEL_NAMES, parseGuardResult } from '@/utils/narrativeGuard';
import { appendStateHistory, createInitialStateHistory, getInitialGameState, normalizeGameState, validateStateProposal, verifyStateHistory, type GameState, type StateHistoryEntry } from '@/app/lib/narrative-state';
import { getPlayerCharacter, getScene } from '@/utils/game';
import { getLanguageShort, translateTexts } from '@/utils/hooks/useLocalTranslator';
import { generateSceneUuid } from '@/utils/uuid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentSceneId, getLatestSceneId, getSceneLines } from '../utils/scene';
import { PlaythroughUpdateProps } from '../utils/types';
import { TriggerManager } from './TriggerManager';

const LINES_BUFFER = 10; // Generate up until this many lines eagerly

function getEventImageUrl(lines: DisplayLine[], currentSceneId: string): string | null {
  const sceneLines = getSceneLines(lines, currentSceneId);
  for (let i = sceneLines.length - 1; i >= 0; i--) {
    const line = sceneLines[i];
    if (line.metadata?.eventImageUrl) {
      return line.metadata.eventImageUrl;
    }
  }
  return null;
}

export function useStoryGenerator({
  currentPlaythrough,
  updatePlaythrough,
  eagerlyGenerate = true,
  readOnly = false,
}: {
  currentPlaythrough?: Playthrough;
  updatePlaythrough: (props: PlaythroughUpdateProps) => Promise<void>;
  eagerlyGenerate?: boolean;
  readOnly?: boolean;
}): StoryState {
  const { addToast } = useToastStore();
  const project = currentPlaythrough?.projectSnapshot;
  const { scenes, characters, style } = project?.cartridge || {};
  const [isLoading, setIsLoading] = useState(false);
  const playthroughIdRef = useRef<number | undefined>(currentPlaythrough?.id);

  const generatingRef = useRef(false);
  const startedRef = useRef(false);
  const processingUserInputRef = useRef(false);
  const lastChainedLengthRef = useRef(0);
  const makingLocalChangesRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  /* States */
  const [eventImageUrl, setEventImageUrl] = useState<string | null>(null);
  const [currentLineIdx, setCurrentLineIdx] = useState(currentPlaythrough?.currentLineIdx || 0);
  const [currentSceneId, setCurrentSceneId] = useState(currentPlaythrough?.currentSceneId || '');
  const [lines, setLines] = useState<DisplayLine[]>(currentPlaythrough?.lines || []);

  /* Cancel any ongoing generation when playthrough changes */
  useEffect(() => {
    return () => {
      // Abort any ongoing generation when playthrough changes
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      generatingRef.current = false;
      processingUserInputRef.current = false;
      startedRef.current = false;
    };
  }, [currentPlaythrough?.id]);

  /* Sync local state when playthrough changes (e.g., from History overlay) */
  useEffect(() => {
    if (!currentPlaythrough) return;
    if (makingLocalChangesRef.current) return; // Don't sync when we're making local changes
    const { lines, currentLineIdx, currentSceneId } = currentPlaythrough;

    // Always derive currentSceneId from the line metadata based on current position
    setLines(lines);
    setCurrentLineIdx(currentLineIdx);
    setCurrentSceneId(currentSceneId);
    setEventImageUrl(getEventImageUrl(lines, currentSceneId));
  }, [currentPlaythrough?.id]);

  // If state updates, playthrough should update (but skip in read-only mode)
  useEffect(() => {
    if (!project || readOnly) return;

    const timeoutId = setTimeout(() => {
      updatePlaythrough({
        action: 'progress',
        playthroughId: currentPlaythrough?.id,
        updates: {
          lines,
          currentLineIdx,
          currentSceneId,
        },
      });
    }, 100); // Debounce updates

    return () => clearTimeout(timeoutId);
  }, [lines, currentLineIdx, currentSceneId, project?.id, readOnly]);

  /* Reactive states */
  // Current scene is based on the currentSceneId
  const currentScene = useMemo(() => {
    if (!project || !currentSceneId) return getBlankScene(generateSceneUuid());
    return getScene(project, currentSceneId);
  }, [currentSceneId, project?.cartridge.scenes]);

  // Latest scene is based on the last line in the story
  const latestScene = useMemo(() => {
    const latestSceneId = getLatestSceneId(lines);
    if (!project || !latestSceneId) return getBlankScene(generateSceneUuid());
    return getScene(project, latestSceneId);
  }, [lines]);

  // TriggerManager is only created for the latest scene (where new content is generated)
  const triggerManager = useMemo((): TriggerManager | null => {
    if (!project || !lines || lines.length === 0) {
      return null;
    }

    // Filter lines to only include those from the latest scene
    const latestSceneLines = getSceneLines(lines, latestScene.uuid);
    return new TriggerManager(latestScene.triggers, latestSceneLines);
  }, [lines, latestScene.triggers, latestScene.uuid]);

  const currentTriggerManager = triggerManager;

  const currentLine = useMemo((): DisplayLine => {
    if (!lines || !project || lines.length === 0) {
      return { type: 'narration', text: '' } as DisplayLine;
    }

    const line = lines[currentLineIdx];
    const atEnd = currentLineIdx === lines.length - 1;

    const status: DisplayLineStatus | undefined = (() => {
      if (line && line.metadata?.shouldEnd) {
        return 'game-over';
      }

      if (atEnd) {
        if (isLoading) {
          return 'loading';
        }
        return line.metadata?.shouldPause ? 'waiting-on-user' : undefined;
      }

      return undefined;
    })();

    if (line && status) {
      const metadata = {
        ...(line.metadata || {}),
        status,
      };
      return {
        ...line,
        metadata,
      } as DisplayLine;
    }

    return line;
  }, [lines, currentLineIdx, isLoading, project]);

  const generateNextLine = useCallback(async () => {
    // Check if already generating to prevent race conditions
    if (generatingRef.current) {
      console.log('already generating, skipping');
      return;
    }

    if (!lines || !project || readOnly || isLoading) {
      console.log('not generating next line');
      return;
    }

    let currentLines = [...lines];

    // Stop immediately if already paused at the end
    const last = currentLines[currentLines.length - 1];
    if (last?.metadata?.shouldPause || last?.metadata?.shouldEnd) {
      console.log('already paused at the end');
      return;
    }

    // Error if no trigger manager
    if (!triggerManager) {
      console.log('no trigger manager');
      return;
    }

    // Mark as generating and save the current playthrough id
    generatingRef.current = true;
    playthroughIdRef.current = currentPlaythrough?.id;

    // Create abort controller for this generation
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    setIsLoading(true);
    try {
      const triggers = triggerManager.getActivatedTriggers();

      // Ensure fallback (and any other) activated triggers are recorded on the last player line
      if (triggers.length > 0 && currentLines.length > 0) {
        const lastIdx = currentLines.length - 1;
        const lastLine = currentLines[lastIdx];
        if (lastLine.type === 'player') {
          const triggerUuids = triggers.map((t) => t.uuid).filter((id): id is string => !!id);
          const existing = lastLine.metadata?.activatedTriggerIds ?? [];
          const merged = Array.from(new Set([...(existing || []), ...triggerUuids]));
          if (merged.length !== existing.length) {
            currentLines[lastIdx] = {
              ...lastLine,
              metadata: {
                ...(lastLine.metadata || {}),
                activatedTriggerIds: merged,
              },
            } as DisplayLine;
          }
        }
      }

      // Check if aborted before API call
      if (signal.aborted) {
        console.log('Generation aborted before API call');
        return;
      }

      const { lines: rawStepLines, stateChange, gistMemory } = await apiClient.generateStep({
        project: project!,
        playthrough: {
          ...currentPlaythrough!,
          currentLineIdx: currentLines.length - 1,
          currentSceneId,
          lines: currentLines,
        },
        triggers,
        signal,
      });
      let stepLines = rawStepLines;

      // Check if aborted after API call
      if (signal.aborted) {
        console.log('Generation aborted after API call');
        return;
      }

      // State is read from the latest committed hash history, never from an LLM narrative claim.
      const latestStateLine = [...currentLines].reverse().find((line) => line.metadata?.narrativeHistory || line.metadata?.narrativeState);
      const stateScene = getScene(project!, currentSceneId);
      const statePlace = project!.cartridge.places.find((place) => place.uuid === stateScene.placeId);
      const initialState = getInitialGameState(project!, statePlace?.name ?? '알 수 없음');
      let stateHistory = (latestStateLine?.metadata?.narrativeHistory as StateHistoryEntry[] | undefined) ?? await createInitialStateHistory(initialState);
      let committedState: GameState = initialState;
      let integrityValid = await verifyStateHistory(stateHistory);
      if (integrityValid.valid) {
        committedState = normalizeGameState(stateHistory[stateHistory.length - 1].state, initialState.location);
        const storedState = latestStateLine?.metadata?.narrativeState;
        if (storedState && JSON.stringify(normalizeGameState(storedState, initialState.location)) !== JSON.stringify(committedState)) {
          integrityValid = { valid: false, reason: 'state does not match last history entry' };
        }
      }
      let proposalAccepted = integrityValid.valid;
      let rejectionReason = integrityValid.reason;
      if (!integrityValid.valid) {
        // A broken chain is not trusted. Re-establish a clean chain from scenario-configured defaults.
        committedState = initialState;
        stateHistory = await createInitialStateHistory(initialState);
      }
      if (integrityValid.valid && stateChange && Object.keys(stateChange).length > 0) {
        const validLocations = new Set(project!.cartridge.places.map((place) => place.name.trim().toLocaleLowerCase()));
        const validation = validateStateProposal(committedState, stateChange as never, validLocations);
        proposalAccepted = validation.valid;
        rejectionReason = validation.reason;
        if (validation.valid) committedState = validation.state;
      }
      if (!proposalAccepted) {
        // Keep the previous committed state and do not show internal validation errors to the player.
        stepLines = stepLines.map((line, index) => index === 0 ? { ...line, text: '잠시 상황이 어긋난 듯합니다. 당신은 행동을 멈추고 주변을 다시 살핍니다.', metadata: { ...line.metadata, shouldPause: true } } : line);
        console.warn('State proposal rejected:', rejectionReason);
      }
      stateHistory = await appendStateHistory(stateHistory, committedState, proposalAccepted ? 'accepted generated turn' : `rejected generated turn: ${rejectionReason ?? 'validation failed'}`, proposalAccepted, stateChange ?? null);
      if (stepLines.length > 0) {
        const lastIndex = stepLines.length - 1;
        stepLines[lastIndex] = { ...stepLines[lastIndex], metadata: { ...stepLines[lastIndex].metadata, narrativeState: committedState, narrativeHistory: stateHistory, stateIntegrityValid: proposalAccepted, ...(gistMemory ? { gistMemory } : {}) } };
      }

      // Translate lines
      const textsToTranslate = stepLines.map((line) => line.text);
      const translatedTexts = await translateTexts(textsToTranslate, getLanguageShort());
      stepLines.forEach((line, index) => {
        line.text = translatedTexts[index];
      });

      // if trigger event image exists, add to the line metadata
      const eventImages = triggers
        .filter((trigger) => trigger.eventImageUrl)
        .map((trigger) => trigger.eventImageUrl);
      if (eventImages.length > 0 && stepLines.length > 0) {
        stepLines[0] = {
          ...stepLines[0],
          metadata: {
            ...(stepLines[0].metadata || {}),
            eventImageUrl: eventImages[0],
          },
        };
      }

      // Ignore stale results from previous playthrough
      if (currentPlaythrough?.id !== playthroughIdRef.current) {
        return;
      }

      if (stepLines.length > 0) {
        currentLines = [...currentLines, ...stepLines];

        // Check if the generated line has shouldPause and generate a hint line
        const lastGeneratedLine = stepLines[stepLines.length - 1];
        const shouldGenerateHint = lastGeneratedLine?.metadata?.shouldPause;

        if (shouldGenerateHint) {
          // Remove shouldPause from the original line
          const modifiedStepLines = [...stepLines];
          modifiedStepLines[modifiedStepLines.length - 1] = {
            ...lastGeneratedLine,
            metadata: {
              ...lastGeneratedLine.metadata,
              shouldPause: false,
            },
          };

          // Update currentLines with the modified step lines
          currentLines = [...currentLines.slice(0, -stepLines.length), ...modifiedStepLines];

          // Check if aborted before hint generation
          if (signal.aborted) {
            console.log('Generation aborted before hint generation');
            return;
          }

          // Generate hint line
          const playerCharacter = getPlayerCharacter(project);
          if (scenes && style) {
            const { lines: hintLines } = await apiClient.getHint({
              lines: currentLines,
              scenes,
              triggerConditions: Object.values(triggerManager.possibleTriggers()).map(
                (trigger) => trigger.condition,
              ),
              style: style.prompt,
              playerCharacterName: playerCharacter.name,
            });

            // Check if aborted after hint generation
            if (signal.aborted) {
              console.log('Generation aborted after hint generation');
              return;
            }

            // translate hint lines
            const hintTextsToTranslate = hintLines.map((line) => line.text);
            const hintTranslatedTexts = await translateTexts(
              hintTextsToTranslate,
              getLanguageShort(),
            );
            hintLines.forEach((line, index) => {
              line.text = hintTranslatedTexts[index];
            });

            // Append hint lines to currentLines before setting state
            currentLines = [...currentLines, ...hintLines];
          }
        }

        // Set lines only once with both generated line(s) and hint (if applicable)
        setLines(currentLines);
      }
    } catch (err) {
      // Ignore abort errors, surface others
      if (err instanceof Error && err.name !== 'AbortError') {
        const errorMessage = err.message;
        addToast(errorMessage);
      }
    } finally {
      generatingRef.current = false;
      setIsLoading(false);
    }
  }, [lines, currentLineIdx, currentSceneId, project, readOnly]);

  // Eagerly chain generation after a kickoff until buffer/pause/transition/end
  useEffect(() => {
    if (
      !eagerlyGenerate ||
      generatingRef.current ||
      !startedRef.current ||
      processingUserInputRef.current ||
      isLoading ||
      !lines ||
      lines.length === 0
    )
      return;

    // Always consider eager from the end of lines
    const last = lines[lines.length - 1];
    if (last?.metadata?.shouldPause || last?.metadata?.shouldEnd) return;

    const diffFromIdx = lines.length - currentLineIdx;
    if (diffFromIdx >= LINES_BUFFER) return;

    // Ensure we only chain once per new length
    if (lines.length <= lastChainedLengthRef.current) return;
    lastChainedLengthRef.current = lines.length;

    // Kick another single-step generation
    generateNextLine();
  }, [currentLineIdx, lines, eagerlyGenerate, generateNextLine]);

  // Visually disable the next button if the next line is not yet generated
  const disabledNext = useMemo(() => {
    // If not the last line, return false
    if (currentLineIdx < lines.length - 1) {
      return false;
    }

    // If we still have opening script to get through
    const idxSinceSceneStart = getSceneLines(lines, currentSceneId).length - 1;
    if (idxSinceSceneStart < currentScene.script.length) {
      return false;
    }

    // If the current line is pause or end
    if (currentLine.metadata?.shouldPause || currentLine.metadata?.shouldEnd) {
      return true;
    }

    return false;
  }, [currentLine]);

  // Visually disable the back button if we're on the first line
  const disabledBack = useMemo(() => {
    return currentLineIdx <= 0;
  }, [currentLineIdx]);

  const handleLineIdxClick = (lineIdx: number) => {
    if (!project) return false;

    // Check bounds
    if (lineIdx < 0 || lineIdx >= lines.length) return false;

    // Check if the new line is in a new scene
    const newSceneId = getCurrentSceneId(lines, lineIdx);
    const isNewScene = newSceneId && newSceneId !== currentSceneId;

    if (isNewScene) {
      setEventImageUrl(getEventImageUrl(lines, newSceneId));
      setCurrentSceneId(newSceneId);
    }
    setCurrentLineIdx(lineIdx);
    return true;
  };

  const handleNext = () => {
    if (currentLineIdx < lines.length - 1) {
      const proposedIdx = currentLineIdx + 1;
      const nextLine = lines[proposedIdx];
      if (!nextLine) return;

      const eventImageUrl = nextLine?.metadata?.eventImageUrl;
      if (eventImageUrl) {
        setEventImageUrl(eventImageUrl);
      }
      return handleLineIdxClick(proposedIdx);
    }

    // Return immediately if we can return one of the opening lines
    const openingScript = currentScene.script;
    const idxSinceSceneStart = getSceneLines(lines, currentSceneId).length - 1;
    if (idxSinceSceneStart < openingScript.length) {
      const nextLine = openingScript[idxSinceSceneStart];
      setLines([...lines, nextLine]);
      setCurrentLineIdx(lines.length);
      return;
    }

    // Kickoff chaining
    // Initialize chained length to current lines to avoid double-fire at start
    startedRef.current = true;
    lastChainedLengthRef.current = lines.length;
    generateNextLine();
  };

  const handleBack = () => {
    if (disabledBack) {
      return;
    }

    const newLineIdx = currentLineIdx - 1;
    const sceneId = getCurrentSceneId(lines, newLineIdx);
    if (sceneId) {
      setEventImageUrl(getEventImageUrl(lines, sceneId));
      setCurrentSceneId(sceneId);
    }

    handleLineIdxClick(newLineIdx);
  };

  const redoFromLine = async () => {
    if (!project || !currentPlaythrough) return;

    // Cancel any ongoing generation before creating duplicate
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    generatingRef.current = false;
    processingUserInputRef.current = false;
    setIsLoading(false);

    const newLines = lines.slice(0, currentLineIdx + 1);
    await updatePlaythrough({
      action: 'duplicate',
      updates: {
        lines: newLines,
        currentLineIdx,
        currentSceneId,
      },
    });
  };

  const handleUserInput = async (input: string) => {
    if (!project || !triggerManager || !scenes || !characters || !style) return;

    processingUserInputRef.current = true;
    setIsLoading(true);

    let shouldContinueStory = false;


    try {
      // Append user input to the end of the existing lines
      const baseLines = lines.slice(0, currentLineIdx + 1);
      const playerCharacter = getPlayerCharacter(project);

      const guardScene = getScene(project, currentSceneId);
      const npcCharacters = characters.filter(character =>
        guardScene.characterIds.includes(character.uuid) && character.uuid !== playerCharacter.uuid);
      // Observation only: run before the guard, without awaiting or altering its decision.
      // Match the status panel's visible-state source, including its initial-location fallback.
      if (process.env.NODE_ENV === 'development') {
        const currentPlace = project.cartridge.places.find(place => place.uuid === guardScene.placeId);
        const startingPlaceId = getScene(project, project.settings.startingSceneId).placeId;
        const initialLocation = currentPlace?.name ?? project.cartridge.places.find(place => place.uuid === startingPlaceId)?.name ?? '알 수 없음';
        const stateLine = [...baseLines].reverse().find(line => line.metadata?.narrativeState);
        const stateReference = normalizeGameState(stateLine?.metadata?.narrativeState ?? project.settings.initialGameState, initialLocation);
        void actionObserver.observe(String(currentPlaythrough?.id), {
          playerInput: input,
          recentLines: baseLines.filter(line => line.text?.trim()).slice(-12).map(line => ({
            role: line.type === 'player' ? 'player' as const : line.type === 'character' ? 'npc' as const : 'narration' as const,
            text: line.text.slice(0, 4000),
          })),
          stateReference: {...stateReference},
        }).catch(() => { /* Observation must never stop the original game flow. */ });
      }
      const guardResponse = await fetch('/api/gen/story/guard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerInput: input,
          context: {
            global: {
              style: style.prompt || '',
              description: project.settings.longDescription || '',
              genre: project.settings.genre || '',
            },
            language: getLanguageShort(),
            player: { name: playerCharacter.name, description: playerCharacter.description },
            scene: { title: guardScene.title, prompt: guardScene.prompt || '' },
            characters: npcCharacters.map(character => ({name: character.name, description: character.description})),
            places: project.cartridge.places.map(place => ({name: place.name, description: place.description})),
            recentLines: baseLines.slice(-40).map(line => ({
              type: line.type, text: line.text, characterName: line.characterName,
            })),
            priorPlayerStatements: baseLines.filter(line => line.type === 'player').slice(-20).map(line => line.text),
            eventConditions: guardScene.triggers.flatMap(trigger =>
              trigger.type === 'action' ? [trigger.condition] : []),
          },
        }),
      });
      if (!guardResponse.ok) {
        throw new Error('입력 검사를 완료하지 못했습니다. 잠시 후 다시 시도해주세요.');
      }
      const guardDecision = parseGuardResult(await guardResponse.json(), npcCharacters.map(c => c.name));
      if (!guardDecision.allowed) {
        // Debug UI only: all detected attack labels are shown, never stored in story history.
        addToast(`공격 감지: ${guardDecision.labels.map(label => LABEL_NAMES[label]).join(' · ')}`);
        if (guardDecision.responseSource === 'fallback') {
          addToast('서사 반응 생성 실패: 임시 안내로 대체되었습니다.');
        }
        const reactionLines = guardDecision.lines.map(line => ({
          ...line,
          ...(line.type === 'character'
            ? {characterId: npcCharacters.find(c => c.name === line.characterName)?.uuid}
            : {}),
        }));
        const guardedLines = [...baseLines, ...reactionLines];
        setLines(guardedLines);
        // Show the first reaction line, not only the last. The final line pauses for input.
        setCurrentLineIdx(baseLines.length);
        lastChainedLengthRef.current = guardedLines.length;
        return;
      }

      // 정상 입력만 아래의 원본 처리 흐름으로 전달합니다.
      const userLine: DisplayLine = {

        type: 'player',
        text: input,
        characterName: playerCharacter.name,
        metadata: { shouldPause: false },
      } as DisplayLine;

      let newLines = [...baseLines, userLine];

      // 정상 판정을 받은 입력만 화면과 이야기 기록에 추가합니다.
      setLines(newLines);
      shouldContinueStory = true;
      const newLineIdx = currentLineIdx + 1;
      setCurrentLineIdx(Math.min(newLineIdx, newLines.length - 1));

      // After user interaction, allow eager chaining if needed
      startedRef.current = true;
      lastChainedLengthRef.current = newLines.length;

      // Now check triggers in parallel while user sees their input
      const sceneLines = getSceneLines(newLines, currentSceneId || '');
      const possibleTriggers = triggerManager.possibleTriggers();
      if (Object.values(possibleTriggers).length > 0) {
        const activatedTriggerIds = await apiClient.checkTriggers({
          scenes,
          possibleTriggers,
          lines: sceneLines,
        });

        // Update the line with trigger information
        newLines = [...newLines];
        newLines[newLines.length - 1] = {
          ...userLine,
          metadata: {
            ...userLine.metadata,
            activatedTriggerIds,
            shouldPause: false,
          },
        } as DisplayLine;

        // Update lines with trigger info
        setLines(newLines);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error occurred';
      addToast(error);
    } finally {
      processingUserInputRef.current = false;
      setIsLoading(false);

      // 차단되거나 검사에 실패한 입력은 후속 생성을 시작하지 않습니다.
      if (shouldContinueStory) {
        handleNext();
      }
    }
  };

  const handleHintRequest = async () => {
    if (!project || !triggerManager || !scenes || !style) return;

    setIsLoading(true);
    try {
      const playerCharacter = getPlayerCharacter(project);
      const { lines: hintLines } = await apiClient.getHint({
        lines,
        scenes,
        triggerConditions: Object.values(triggerManager.possibleTriggers()).map(
          (trigger) => trigger.condition,
        ),
        style: style.prompt,
        playerCharacterName: playerCharacter.name,
      });

      // Add hint lines to current lines
      const newLines = [...lines, ...hintLines];
      setLines(newLines);
      setCurrentLineIdx(newLines.length - 1);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Unknown error occurred';
      addToast(error);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    lines,
    currentLineIdx,
    eventImageUrl,
    disabledNext: disabledNext || false,
    disabledBack: disabledBack || false,
    currentLine,
    currentScene,
    latestScene,
    triggerManager,
    currentTriggerManager,
    handleNext,
    handleBack,
    handleUserInput,
    handleHintRequest, // TESTING only
    setCurrentLineIdx,
    redoFromLine,
  };
}
