import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {Store} from '../electron/store.mjs';
import {checkDetailDeletionUI} from './deletion-ui-checks.mjs';
import {checkCancelCleanupUI} from './cancel-cleanup-ui-checks.mjs';

const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','MutationObserver','Event','MouseEvent','KeyboardEvent'])globalThis[key]=key==='window'?dom.window:dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
dom.window.HTMLElement.prototype.scrollTo=function({top}){this.scrollTop=top;};
dom.window.HTMLMediaElement.prototype.pause=function(){};
dom.window.HTMLMediaElement.prototype.play=function(){return Promise.resolve();};
const {act}=await import('react');globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const base=fs.mkdtempSync(path.resolve('.test-output/detail-deletion-'));
const store=await Store.open(path.join(base,'test.sqlite'),path.join(base,'media'));
store.upsertWork({aweme_id:'889900',desc:'详情删除测试样本',author:{uid:'1',nickname:'测试作者'},video:{play_addr:{url_list:[]}}});
store.ingestMembers('__all__',['889900'],true);
const data=()=>({...store.snapshot(),storage:{mode:'backup',writable:true,connected:true,scopedDeletion:true},collector:{busy:false,connected:false},queue:{jobs:[],paused:true}});
let notify=()=>{};
window.cangxia={state:async()=>data(),onChange:fn=>{notify=fn;return()=>{};}};
const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
const click=async text=>{const root=document.querySelector('.modal')||document;const button=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===text);assert.ok(button,'button: '+text);assert.equal(button.disabled,false,'enabled: '+text);await act(async()=>{button.click();await settle();});};
const aria=async label=>{const button=document.querySelector(`[aria-label="${label}"]`);assert.ok(button,label);await act(async()=>{button.click();await settle();});};
const checks=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
try{
 await act(async()=>{await import('../.test-output/detail-delete-dom-build/main.js');await settle();});
 await checkDetailDeletionUI({notify:(value)=>notify(value),data,act,settle,click,aria,check});
 await checkCancelCleanupUI({notify:(value)=>notify(value),data,act,settle,click,aria,check});
 console.log(JSON.stringify({ok:true,checks},null,2));
}finally{store.close();dom.window.close();}
process.exit(0);
