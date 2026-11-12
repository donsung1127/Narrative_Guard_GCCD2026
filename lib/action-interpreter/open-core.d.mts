export interface OpenEntity {id:string;name:string;kind:string;aliases:string[]}
export interface OpenContext {schemaVersion:1;playerInput:string;playerId:string|null;entities:OpenEntity[];scene:{id:string;title:string;description:string}|null;recentLines:{role:'player'|'npc'|'narration';text:string}[];stateReference:Record<string,unknown>|null}
export interface EntityReference {text:string;resolution:'linked'|'ambiguous'|'unlinked';entityId:string|null;candidateIds:string[]}
export interface OpenAction {summary:string;predicate:string;mode:'attempt'|'inquiry'|'speech'|'claim';polarity:'positive'|'negative';actor:EntityReference|null;target:EntityReference|null;recipient:EntityReference|null;source:EntityReference|null;destination:EntityReference|null;instrument:EntityReference|null;quantity:number|null;manner:string[];condition:string|null;utterance:string|null;claimedOutcome:string|null;evidence:{source:'input'|'history';lineIndex:number|null;quote:string}[]}
export type OpenProposal = {schemaVersion:1;status:'interpreted'|'needs_clarification'|'non_action';actions:OpenAction[];clarification:{question:string;actionIndices:number[];missingFields:string[]}|null}|{status:'invalid_output'|'unavailable';reasonCode:string};
export function validateOpenContext(value:unknown):OpenContext;
export function parseOpenProposal(raw:string,input:OpenContext):OpenProposal;
export function buildOpenMessages(input:OpenContext):{systemPrompt:string;messages:{role:'user';content:string}[]};
export function interpretOpenAction(input:OpenContext,generate:(systemPrompt:string,messages:{role:'user';content:string}[])=>Promise<string>):Promise<OpenProposal>;
