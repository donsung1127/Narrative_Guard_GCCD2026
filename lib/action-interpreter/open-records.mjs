// Memory-only diagnostic records. Not an execution log or persistent database.
const records=[]; const listeners=new Set();const LIMIT=100;
export function subscribeOpenRecords(fn){listeners.add(fn);return ()=>{listeners.delete(fn);};}
export function listOpenRecords(sessionKey){return records.filter(r=>r.sessionKey===String(sessionKey)).map(r=>structuredClone(r));}
export function clearOpenRecords(sessionKey){for(let i=records.length-1;i>=0;i--)if(records[i].sessionKey===String(sessionKey))records.splice(i,1);for(const fn of listeners)fn();}
export async function observeOpenRecorded({sessionKey,sceneId,input},send){
 const record={recordVersion:1,id:globalThis.crypto.randomUUID(),sessionKey:String(sessionKey),sceneId,startedAt:new Date().toISOString(),mode:'observation_only',request:structuredClone(input),response:null,error:null,durationMs:null};const started=Date.now();
 records.push(record);if(records.length>LIMIT)records.shift();for(const fn of listeners)fn();
 try{const r=await send();record.response=await r.json();if(!r.ok)record.error=`http_${r.status}`;}catch{record.error='request_failed';}finally{record.durationMs=Date.now()-started;for(const fn of listeners)fn();}
 return structuredClone(record);
}
