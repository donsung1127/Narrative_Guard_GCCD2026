export interface OpenRecord {recordVersion:number;id:string;sessionKey:string;sceneId:string;startedAt:string;mode:string;request:unknown;response:unknown;error:string|null;durationMs:number|null;}
export function subscribeOpenRecords(fn:()=>void):()=>void;
export function listOpenRecords(sessionKey:string):OpenRecord[];
export function clearOpenRecords(sessionKey:string):void;
export function observeOpenRecorded(input:{sessionKey:string;sceneId:string;input:unknown},send:()=>Promise<Response>):Promise<OpenRecord>;
