import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
import {verificationPanelScript,validPanel,panelLayout} from '../electron/verification-panel.mjs';
function page(html){const dom=new JSDOM(html,{runScripts:'outside-only'});Object.defineProperty(dom.window,'innerWidth',{value:1000});Object.defineProperty(dom.window,'innerHeight',{value:760});dom.window.HTMLElement.prototype.getBoundingClientRect=function(){const [x,y,width,height]=(this.getAttribute('data-rect')||'250,220,150,25').split(',').map(Number);return {x,y,width,height,left:x,top:y,right:x+width,bottom:y+height};};return dom;}
test('crop identifies the official card rather than the full-page backdrop',()=>{
 const dom=page('<body data-rect="0,0,1000,760"><aside>背景导航</aside><div data-rect="0,0,1000,760" style="background:black"><section style="background:white;border-radius:16px" data-rect="150,100,700,480"><h2>身份验证</h2><button>接收短信验证码</button><button>发送短信验证</button></section></div></body>');
 assert.deepEqual(JSON.parse(JSON.stringify(dom.window.eval(verificationPanelScript()))),{x:150,y:100,width:700,height:480});dom.window.close();
});
test('code-entry step can retain its original input without reading the code',()=>{
 const dom=page('<body><section role="dialog" data-rect="250,140,500,400"><p>验证你的手机</p><input placeholder="请输入验证码"></section></body>');Object.defineProperty(dom.window.document.querySelector('input'),'value',{get(){throw Error('private code');}});
 assert.equal(dom.window.eval(verificationPanelScript()).width,500);dom.window.close();
});
test('unrecognized page does not expose the whole website in the compact slot',()=>{
 const dom=page('<body data-rect="0,0,1000,760"><h2>我的抖音</h2></body>');assert.equal(dom.window.eval(verificationPanelScript()),null);dom.window.close();
});
test('invalid or full-viewport panels cannot be mounted',()=>{assert.equal(validPanel({x:0,y:0,width:1000,height:760}),false);assert.equal(validPanel({x:NaN,y:0,width:700,height:480}),false);assert.equal(validPanel({x:500,y:0,width:700,height:480}),false);});
test('crop preserves the original page viewport and fits only the card inside the slot',()=>{
 const r={x:150,y:100,width:700,height:480},slot={x:400,y:200,width:500,height:340};const result=panelLayout(r,slot);assert.ok(result.clip.width<=slot.width&&result.clip.height<=slot.height);assert.ok(result.clip.x>=slot.x&&result.clip.y>=slot.y);assert.ok(result.page.x<0&&result.page.y<0);assert.ok(Math.abs(result.page.width/result.zoom-1000)<2);assert.ok(Math.abs(result.page.height/result.zoom-760)<2);
});
