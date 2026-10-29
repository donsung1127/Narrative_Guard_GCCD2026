'use client';

import { useMemo } from 'react';
import { XMarkIcon, ArrowDownTrayIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import { normalizeGistMemory, type GistMemory } from '@/app/lib/gist-memory';

type Props = {
  memory: unknown;
  onClose: () => void;
};

function downloadJson(memory: GistMemory) {
  const json = JSON.stringify(memory, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gist-memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function GistMemoryPanel({ memory, onClose }: Props) {
  const normalizedMemory = useMemo(() => normalizeGistMemory(memory), [memory]);
  const jsonText = useMemo(() => JSON.stringify(normalizedMemory, null, 2), [normalizedMemory]);

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(jsonText);
    } catch (error) {
      // Clipboard access may be unavailable in insecure contexts; the JSON remains visible below.
      console.warn('Could not copy Gist Memory JSON:', error);
    }
  };

  return (
    <div className="absolute inset-0 z-[40] flex items-start justify-center overflow-y-auto bg-black/60 p-3 pt-20 sm:p-6 sm:pt-20" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="gist-memory-title"
        className="w-full max-w-3xl overflow-hidden rounded-xl border border-slate-600 bg-slate-950 text-slate-100 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
          <div>
            <h2 id="gist-memory-title" className="text-lg font-bold">Gist Memory</h2>
            <p className="mt-1 text-sm text-slate-400">
              누적된 서사 요약 {normalizedMemory.episodes.length}개 · 게임 상태를 대체하지 않는 파생 기억
            </p>
          </div>
          <button type="button" aria-label="닫기" onClick={onClose} className="rounded-lg p-2 hover:bg-white/10">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="flex flex-wrap gap-2 border-b border-white/10 p-4">
          <button type="button" onClick={() => downloadJson(normalizedMemory)} className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-400">
            <ArrowDownTrayIcon className="h-4 w-4" /> JSON 다운로드
          </button>
          <button type="button" onClick={copyJson} className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10">
            <ClipboardDocumentIcon className="h-4 w-4" /> JSON 복사
          </button>
        </div>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto p-4">
          {normalizedMemory.episodes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/20 p-5 text-sm text-slate-400">
              아직 저장된 에피소드 요약이 없습니다. 대사가 충분히 누적되거나 씬이 변경된 후 다시 확인하세요.
            </div>
          ) : normalizedMemory.episodes.slice().reverse().map((episode) => (
            <article key={episode.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{episode.id}</h3>
                <span className="text-xs text-slate-400">씬: {episode.sceneId || '미지정'} · 원본 대사 {episode.sourceStartLine}–{episode.sourceEndLine}</span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{episode.summary}</p>
              {episode.keyEvents.length > 0 && <MemoryList title="핵심 사건" values={episode.keyEvents} />}
              {episode.relationshipChanges.length > 0 && <MemoryList title="관계 변화" values={episode.relationshipChanges} />}
              {episode.openThreads.length > 0 && <MemoryList title="미해결 사건" values={episode.openThreads} />}
              <p className="mt-3 text-xs text-slate-500">생성: {new Date(episode.createdAt).toLocaleString()}</p>
            </article>
          ))}

          <details className="rounded-lg border border-white/10">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">전체 JSON 원문 보기</summary>
            <pre className="max-h-72 overflow-auto border-t border-white/10 p-3 text-xs leading-5 text-emerald-200">{jsonText}</pre>
          </details>
        </div>
      </section>
    </div>
  );
}

function MemoryList({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="mt-3">
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400">{title}</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-200">
        {values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}
      </ul>
    </div>
  );
}
