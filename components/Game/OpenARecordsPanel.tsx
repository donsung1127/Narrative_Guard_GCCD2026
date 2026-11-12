import {useEffect,useState} from 'react';
import {listOpenRecords,subscribeOpenRecords,clearOpenRecords,type OpenRecord} from '@/lib/action-interpreter/open-records.mjs';
export default function OpenARecordsPanel({sessionKey}:{sessionKey:string}){
 const [open,setOpen]=useState(false);const [records,setRecords]=useState<OpenRecord[]>([]);
 useEffect(()=>{const update=()=>setRecords(listOpenRecords(sessionKey));update();return subscribeOpenRecords(update);},[sessionKey]);
 const download=()=>{const blob=new Blob([JSON.stringify({exportVersion:1,mode:'observation_only',exportedAt:new Date().toISOString(),sessionKey,records},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='open-a-game-records.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 return <><button type="button" className="absolute left-3 bottom-20 z-[30] rounded bg-slate-900 px-3 py-2 text-xs text-white" onClick={()=>setOpen(true)}>개방형 A 기록</button>{open&&<div className="absolute inset-3 z-[60] overflow-auto rounded bg-slate-950 p-4 text-white select-text"><button type="button" onClick={()=>setOpen(false)}>닫기</button><h2>개방형 A 관찰 기록 ({records.length})</h2><p>실행 승인 아님 · 메모리에 최근 전체 100건 · 새로고침 시 소실</p><button type="button" onClick={download}>현재 플레이 JSON 내려받기</button><button type="button" onClick={()=>clearOpenRecords(sessionKey)}>현재 플레이 기록 비우기</button><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(records,null,2)}</pre></div>}</>;
}
