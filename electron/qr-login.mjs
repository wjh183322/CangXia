import { isDouyinURL, isMediaURL, sleep } from './model.mjs';
import { qrPageScript, validQrRect, webUserAgent } from './qr-page.mjs';

export class QrLogin{
  constructor({createWindow,profile,chromiumVersion,onChange,onAuthenticated,onLimit}){Object.assign(this,{createWindow,profile,onChange,onAuthenticated,onLimit});this.userAgent=webUserAgent(chromiumVersion);this.current={phase:'idle',image:null,message:''};this.generation=0;this.active=false;}
  state(){return {...this.current,active:this.active};}
  update(change){if(Object.entries(change).every(([k,v])=>this.current[k]===v))return;this.current={...this.current,...change};this.onChange();}
  async start(){
    if(this.active)return;
    this.active=true;this.manualPage=false;this.lastImageUrl=null;this.lastImage=null;const generation=++this.generation;this.update({phase:'loading',image:null,message:'正在获取抖音登录二维码'});
    try{
      const cookies=await this.profile.cookies.get({url:'https://www.douyin.com/'});
      if(!this.active||generation!==this.generation)return;
      if(this.loggedIn(cookies)){await this.complete(cookies,generation);return;}
      if(!this.window||this.window.isDestroyed()){
        const win=this.createWindow();this.window=win;
        win.webContents.setUserAgent(this.userAgent);
        win.on('page-title-updated',e=>e.preventDefault());win.setTitle('藏匣 · 抖音登录验证');
        win.webContents.setWindowOpenHandler(({url})=>{if(isDouyinURL(url))void win.loadURL(url);return {action:'deny'};});
        win.webContents.on('will-navigate',(e,url)=>{if(!isDouyinURL(url))e.preventDefault();});
        win.webContents.on('will-redirect',(e,url)=>{if(!isDouyinURL(url))e.preventDefault();});
        win.webContents.on('will-frame-navigate',(e)=>{if(e.url&&e.url!=='about:blank'&&!(e.url.startsWith('https:')&&isMediaURL(e.url)))e.preventDefault();});
        win.on('closed',()=>{if(this.window===win){this.window=null;if(this.active)this.cancel();}});
      }
      this.window.hide();
      void this.window.loadURL('https://www.douyin.com/user/self',{userAgent:this.userAgent}).catch(()=>{if(this.active&&generation===this.generation)this.update({phase:'error',message:'抖音页面未能加载，请稍后手动重试'});});
      void this.watch(generation);
    }catch(e){if(generation===this.generation){this.active=false;this.update({phase:'error',message:e.message});}}
  }
  loggedIn(cookies){return cookies.some(c=>['sessionid','sessionid_ss'].includes(c.name)&&c.value);}
  async complete(cookies,generation){
    if(generation!==this.generation)return;
    try{await this.onAuthenticated({cookies,userAgent:this.userAgent,source:'popup'});}catch(e){this.active=false;this.update({phase:'error',image:null,message:e.message});return;}
    if(generation!==this.generation)return;
    this.active=false;this.update({phase:'success',image:null,message:'登录成功，已连接账号'});
    const win=this.window;this.window=null;if(win&&!win.isDestroyed())win.close();
  }
  async watch(generation){
    const deadline=Date.now()+5*60*1000;let openAttempts=0,lastClick=0;
    while(this.active&&generation===this.generation&&Date.now()<deadline){
      const win=this.window;if(!win||win.isDestroyed())break;
      try{
        const cookies=await this.profile.cookies.get({url:'https://www.douyin.com/'});
        if(this.loggedIn(cookies)){await this.complete(cookies,generation);return;}
        const openLogin=!this.manualPage&&openAttempts<3&&Date.now()-lastClick>5000;
        const page=await win.webContents.executeJavaScript(qrPageScript({openLogin}));
        if(openLogin&&/正在打开|正在获取/.test(page.message)){openAttempts++;lastClick=Date.now();}
        if(!this.active||generation!==this.generation)break;
        if(page.phase==='limited'){this.onLimit?.();this.active=false;this.update({...page,image:null});win.webContents.stop();win.hide();return;}
        if(page.phase==='ready'&&validQrRect(page.rect,win.getContentBounds())){
          const image=await this.qrImage(page);
          if(this.active&&generation===this.generation)this.update(image?{phase:'ready',message:page.message,image}:{phase:'loading',message:'正在读取二维码图片'});
        }else this.update({phase:page.phase,message:page.message,...(['expired','verification'].includes(page.phase)?{image:null}:{})});
      }catch(e){if(this.active&&generation===this.generation&&!win.isDestroyed())this.update({message:'正在等待抖音页面就绪'});}
      await sleep(1000);
    }
    if(this.active&&generation===this.generation){this.active=false;this.update({phase:'expired',image:null,message:'登录等待已结束，请手动重新获取二维码'});}
  }
  async qrImage(page){
    if(typeof page.image==='string'&&/^data:image\/(png|jpeg|webp);base64,/i.test(page.image)&&page.image.length<2*1024*1024)return page.image;
    if(!page.imageUrl||!isMediaURL(page.imageUrl)||!page.imageUrl.startsWith('https:'))return null;
    if(this.lastImageUrl===page.imageUrl&&this.lastImage)return this.lastImage;
    const response=await this.profile.fetch(page.imageUrl,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Referer:'https://www.douyin.com/','User-Agent':this.userAgent}});
    const type=response.headers.get('content-type')?.split(';')[0];if(!response.ok||!['image/png','image/jpeg','image/webp'].includes(type))return null;
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>1024*1024)return null;
    this.lastImageUrl=page.imageUrl;this.lastImage=`data:${type};base64,${bytes.toString('base64')}`;return this.lastImage;
  }
  async refresh(){
    if(Date.now()-(this.lastRefresh||0)<5000)throw new Error('请稍候再刷新二维码');this.lastRefresh=Date.now();
    this.lastImageUrl=null;this.lastImage=null;
    if(!this.active)return this.start();
    if(!this.window||this.window.isDestroyed())return this.start();
    const result=await this.window.webContents.executeJavaScript(qrPageScript({refresh:true}));this.update({...result,image:null});
  }
  showPage(){this.manualPage=true;if(this.window&&!this.window.isDestroyed()){this.window.setSkipTaskbar(false);this.window.show();this.window.focus();}}
  cancel(){this.active=false;this.generation++;const win=this.window;this.window=null;this.update({phase:'idle',image:null,message:''});if(win&&!win.isDestroyed())win.close();}
}
