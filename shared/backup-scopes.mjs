import {validId,validAuthor,stable} from './backup-protocol.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export const validOperationId=value=>typeof value==='string'&&uuid.test(value);
/** @typedef {{workId:string,kind:'account'|'author'|'files',sourceId:string}} Scope */
/** @returns {Scope} */
export function normalizeScope(input){
 if(!object(input)||Object.keys(input).some(k=>!['workId','kind','sourceId'].includes(k))||!validId(input.workId)||!['account','author','files'].includes(input.kind)||!(input.kind==='account'?input.sourceId==='__all__':input.kind==='author'?validAuthor(input.sourceId):input.sourceId===''))throw Error('删除内容范围无效');
 return {workId:input.workId,kind:input.kind,sourceId:input.sourceId};
}
export const scopeKey=input=>{const s=normalizeScope(input);return JSON.stringify([s.workId,s.kind,s.sourceId]);};
export function validateScopeCommand(input){
 if(!object(input)||Object.keys(input).some(k=>!['libraryId','operationId','items'].includes(k))||!validOperationId(input.libraryId)||!validOperationId(input.operationId)||!Array.isArray(input.items)||!input.items.length||input.items.length>100)throw Error('删除或恢复请求无效');
 const seen=new Set(),items=input.items.map(item=>{if(!object(item)||Object.keys(item).some(k=>!['scope','expectedGeneration'].includes(k))||!Number.isSafeInteger(item.expectedGeneration)||item.expectedGeneration<0)throw Error('范围版本无效');const scope=normalizeScope(item.scope),key=scopeKey(scope);if(seen.has(key))throw Error('范围重复');seen.add(key);return {scope,expectedGeneration:item.expectedGeneration};});
 return {libraryId:input.libraryId,operationId:input.operationId,items};
}
export const scopeCommandHashInput=command=>stable(validateScopeCommand(command));
