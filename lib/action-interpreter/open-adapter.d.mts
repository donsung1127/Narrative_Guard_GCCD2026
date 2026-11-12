import type {OpenContext} from './open-core.mjs';
export function fromDramamancer(input:{project:unknown;sceneId:string;playerInput:string;recentLines?:OpenContext['recentLines'];stateReference?:Record<string,unknown>|null}):OpenContext;
