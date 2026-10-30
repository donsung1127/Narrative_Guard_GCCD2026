import {validateContext, parseProposal} from './core.mjs';
export const BASE_COMMIT = '68ca43df8812c3e2172fc8d002cfc6fd5a10cb21';
export function createObserver(transport = (...args) => fetch(...args)) {
  const sessions = new Map();
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());
  const get = key => {
    if (!sessions.has(key)) sessions.set(key, {enabled:false,catalog:[],records:[],epoch:0});
    return sessions.get(key);
  };
  return {
    subscribe(fn) {listeners.add(fn); return () => {listeners.delete(fn);};},
    snapshot(key) {const s=get(key);return {enabled:s.enabled,records:[...s.records]};},
    configure(key, enabled, catalog) {
      // Validate the entire configuration before changing anything.
      const clean = JSON.parse(JSON.stringify(catalog));
      validateContext({playerInput:'configuration', catalog:clean,recentLines:[],stateReference:null});
      Object.assign(get(key), {enabled, catalog:clean});notify();
    },
    disable(key) {get(key).enabled=false;notify();},
    clear(key) {const s=get(key);s.records=[];s.epoch++;notify();},
    async observe(key, input) {
      const s=get(key);if (!s.enabled) return;
      let context;
      try {context=validateContext(JSON.parse(JSON.stringify({...input,catalog:s.catalog})));}
      catch {s.records=[...s.records,{id:crypto.randomUUID(),status:'context_error',startedAt:new Date().toISOString()}].slice(-30);notify();return;}
      const epoch=s.epoch;
      const row={id:crypto.randomUUID(),baseCommit:BASE_COMMIT,mode:'observation_only',
        startedAt:new Date().toISOString(),context,status:'pending'};
      s.records=[...s.records,row].slice(-30);notify();
      const start=performance.now();
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),20000);
      try {
        const response=await transport('/api/gen/story/interpret', {
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify(context),signal:controller.signal,
        });
        row.httpStatus=response.status;
        const body=await response.json();
        row.result = response.ok ? parseProposal(JSON.stringify(body),context.catalog) :
          {status:'unavailable',reasonCode:`http_${response.status}`};
        row.status=response.ok ? (row.result.status === 'invalid_output' ? 'invalid_output' : 'completed') : 'http_error';
      } catch(error) {
        row.status=controller.signal.aborted ? 'timeout' : 'request_error';
      } finally {
        clearTimeout(timer);row.durationMs=Math.round(performance.now()-start);
        // Cleared results must not reappear after a late response.
        if (s.epoch===epoch) notify();
      }
    },
  };
}
export const actionObserver = createObserver();
