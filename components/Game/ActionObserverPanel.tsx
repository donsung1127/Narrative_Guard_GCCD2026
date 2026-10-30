import {useEffect, useState} from 'react';
import {actionObserver} from '@/lib/action-interpreter/observer.mjs';

export default function ActionObserverPanel({sessionKey}:{sessionKey:string}) {
  const [open,setOpen]=useState(false);
  const [catalog,setCatalog]=useState('[]');
  const [error,setError]=useState('');
  const [snapshot,setSnapshot]=useState(()=>actionObserver.snapshot(sessionKey));
  useEffect(()=>{
    const refresh=()=>setSnapshot(actionObserver.snapshot(sessionKey));
    refresh();return actionObserver.subscribe(refresh);
  },[sessionKey]);
  function configure(enabled:boolean) {
    try {actionObserver.configure(sessionKey,enabled,JSON.parse(catalog));setError('');}
    catch {setError('상품 목록을 확인하세요: [{"id":"고유 ID","name":"상품명","aliases":["별칭"]}]');}
  }
  function download() {
    const data={exportedAt:new Date().toISOString(),scope:'A 관찰 모드 — 상태 변경 없음',records:snapshot.records};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='action-observer-records.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <div className="absolute left-3 top-32 z-[30] text-xs text-white" onClick={e=>e.stopPropagation()}>
    <button type="button" className="rounded bg-slate-950 p-2" onClick={()=>setOpen(!open)}>
      A 관찰 모드 {snapshot.enabled?'켜짐':'꺼짐'} ({snapshot.records.length})
    </button>
    {open && <section className="mt-2 max-h-[65vh] w-[min(440px,85vw)] overflow-auto rounded bg-slate-950 p-3 select-text" onKeyDown={e=>e.stopPropagation()}>
      <p>개발 전용 · 상태 변경 없음 · 결과는 현재 페이지 메모리에만 보관(최대 30건)</p>
      <p className="my-2">현재 시나리오의 상품 ID·이름·별칭을 JSON 배열로 입력하세요. 임시 ID는 정식 팀 ID와 구분하세요.</p>
      <textarea aria-label="관찰용 상품 목록 JSON" className="h-28 w-full bg-slate-800 p-2" value={catalog} onChange={e=>setCatalog(e.target.value)} />
      <div className="my-2 flex flex-wrap gap-3">
        <button type="button" onClick={()=>configure(true)}>목록 적용·켜기</button>
        <button type="button" onClick={()=>actionObserver.disable(sessionKey)}>끄기</button>
        <button type="button" onClick={download}>기록 내려받기</button>
        <button type="button" onClick={()=>actionObserver.clear(sessionKey)}>기록 지우기</button>
      </div>
      {error && <p role="alert">{error}</p>}
      <p>기록에는 입력·최근 대화·상태 참조가 포함됩니다. 공유 전 내용을 검토하세요. 구매 성공 또는 B파트 검증 결과가 아닙니다.</p>
      {snapshot.records.map(row=><details key={row.id} className="my-2 border-t border-slate-700 py-2">
        <summary>{row.context?.playerInput ?? '문맥 검증 실패'} — {row.status} {row.durationMs ?? ''} ms</summary>
        <pre className="whitespace-pre-wrap break-all">{JSON.stringify(row,null,2)}</pre>
      </details>)}
    </section>}
  </div>;
}
