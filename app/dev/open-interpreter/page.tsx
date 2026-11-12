'use client';
import {useState} from 'react';
const example={context:{schemaVersion:1,playerInput:'경비병이 안 보는 사이에 담벼락을 타고 넘어간다.',playerId:'character:player',entities:[{id:'character:player',name:'플레이어',kind:'character',aliases:['나']},{id:'character:guard',name:'경비병',kind:'character',aliases:[]}],scene:{id:'scene:gate',title:'성문 앞',description:'경비병이 성문을 지키고 있다.'},recentLines:[],stateReference:null}};
export default function OpenInterpreter(){
 const [input,setInput]=useState(JSON.stringify(example,null,2));const [output,setOutput]=useState('');const [busy,setBusy]=useState(false);
 async function run(){setBusy(true);try{const body=JSON.stringify(JSON.parse(input));const r=await fetch('/api/gen/story/interpret-open',{method:'POST',headers:{'Content-Type':'application/json'},body});setOutput(JSON.stringify({httpStatus:r.status,...await r.json()},null,2));}catch(e){setOutput(String(e));}finally{setBusy(false);}}
 function download(){const url=URL.createObjectURL(new Blob([output],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='open-a-result.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 if(process.env.NODE_ENV!=='development')return <main>개발 환경 전용 화면입니다.</main>;
 return <main className="mx-auto max-w-6xl p-8"><h1 className="text-2xl font-bold">개방형 A 행동 해석 실험</h1><p className="my-4">해석만 수행합니다. 게임 실행·상태 변경·B 승인 여부를 뜻하지 않습니다. 문맥 JSON 또는 source: dramamancer 입력을 사용할 수 있습니다.</p><label htmlFor="context">입력 JSON</label><textarea id="context" className="w-full min-h-96 border p-4 text-black bg-white font-mono" value={input} onChange={e=>setInput(e.target.value)}/><button className="border p-3 mr-3" onClick={run} disabled={busy}>{busy?'해석 중':'A 해석 실행'}</button><button className="border p-3" disabled={!output||busy} onClick={download}>결과 JSON 내려받기</button><pre className="mt-5 whitespace-pre-wrap break-words">{output}</pre></main>;
}
