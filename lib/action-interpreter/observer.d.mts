import type {InterpreterContext, Proposal} from './core.mjs';
export const BASE_COMMIT: string;
export interface ObservationRecord {
 id:string; baseCommit?:string;mode?:string;startedAt:string;
 context?:InterpreterContext;status:string;httpStatus?:number;result?:Proposal;durationMs?:number;
}
export interface Observer {
 subscribe(fn:()=>void):()=>void;
 snapshot(key:string):{enabled:boolean;records:ObservationRecord[]};
 configure(key:string,enabled:boolean,catalog:InterpreterContext['catalog']):void;
 disable(key:string):void;
 clear(key:string):void;
 observe(key:string,input:Omit<InterpreterContext,'catalog'>):Promise<void>;
}
export function createObserver(transport?:typeof fetch):Observer;
export const actionObserver:Observer;
