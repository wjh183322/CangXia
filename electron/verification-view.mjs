import {BaseWindow,WebContentsView,View} from 'electron';
import {EventEmitter} from 'node:events';
import {verificationPanelScript,validPanel,panelLayout} from './verification-panel.mjs';

// A single official page moves between a hidden host, an inline slot and a
// detached fallback. Its WebContents (including in-page verification state) stays the same.
export class VerificationView extends EventEmitter {
  constructor({parent,partition,onVisibility}){
    super();this.parent=parent;this.onVisibility=onVisibility;this.closed=false;this.inline=false;
    this.host=new BaseWindow({width:1000,height:800,show:false,skipTaskbar:true,autoHideMenuBar:true,title:'藏匣 · 抖音登录验证'});
    this.view=new WebContentsView({webPreferences:{partition,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});this.webContents=this.view.webContents;
    this.clip=new View();this.clip.setBounds({x:0,y:0,width:300,height:200});this.clip.setBorderRadius(12);this.clip.setBackgroundColor('#ffffff');this.panel=null;this.slot=null;
    this.owner=this.host.contentView;this.owner.addChildView(this.view);this.view.setBounds({x:0,y:0,width:1000,height:760});this.view.setBackgroundColor('#ffffff');
    this.host.on('resize',()=>{if(!this.inline&&!this.closed){const b=this.host.getContentBounds();this.view.setBounds({x:0,y:0,width:b.width,height:b.height});}});
    this.host.on('close',event=>{if(!this.closed){event.preventDefault();this.close();}});
    this.webContents.on('page-title-updated',(...args)=>this.emit('page-title-updated',...args));
    this.webContents.once('destroyed',()=>{if(!this.closed)this.close();});
    this.panelTimer=setInterval(()=>{if(this.inline)void this.refreshPanel();},500);this.panelTimer.unref();
  }
  detachClip(){this.clipOwner?.removeChildView(this.clip);this.clipOwner=null;}
  move(owner){if(this.owner===owner)return;this.owner?.removeChildView(this.view);owner.addChildView(this.view);this.owner=owner;}
  loadURL(...args){return this.webContents.loadURL(...args);}
  isDestroyed(){return this.closed||this.webContents.isDestroyed();}
  isVisible(){return !this.isDestroyed()&&(this.inline?this.clipOwner===this.parent()?.contentView&&this.clip.getVisible()&&this.view.getVisible()&&this.parent().isVisible():this.host.isVisible());}
  getContentBounds(){const b=this.view.getBounds(),z=this.webContents.getZoomFactor();return {...b,width:b.width/z,height:b.height/z};}
  setTitle(title){this.host.setTitle(title);}
  setSkipTaskbar(value){if(!this.inline)this.host.setSkipTaskbar(value);}
  hide(){if(this.closed)return;this.inline=false;this.detachClip();this.move(this.host.contentView);this.slot=null;this.view.setBounds({x:0,y:0,width:1000,height:760});this.webContents.setZoomFactor(1);this.host.hide();this.onVisibility(false,this.webContents.id);}
  async show(){if(this.closed)return;this.host.hide();this.detachClip();this.move(this.host.contentView);this.view.setBounds({x:0,y:0,width:1000,height:760});this.webContents.setZoomFactor(1);this.inline=true;this.slot=null;await this.refreshPanel();if(this.inline&&!this.closed)this.onVisibility(true,this.webContents.id,!!this.panel);}
  focus(){if(!this.closed&&this.owner===this.clip)this.webContents.focus();}
  async refreshPanel(){
    if(this.isDestroyed()||!this.inline||this.readingPanel)return;this.readingPanel=true;
    try{const rect=await this.webContents.executeJavaScript(verificationPanelScript());if(!this.inline||this.isDestroyed())return;const next=validPanel(rect)?rect:null;if(JSON.stringify(next)!==JSON.stringify(this.panel)){this.panel=next;this.onVisibility(true,this.webContents.id,!!next);}this.layoutPanel();}catch{if(!this.isDestroyed())this.clip.setVisible(false);}finally{this.readingPanel=false;}
  }
  layoutPanel(){
    const win=this.parent();if(!this.inline||!this.slot||!win||win.isDestroyed())return;
    const layout=panelLayout(this.panel,this.slot);if(!layout){this.clip.setVisible(false);return;}
    const first=this.clipOwner!==win.contentView;if(first){this.detachClip();win.contentView.addChildView(this.clip);this.clipOwner=win.contentView;}
    this.move(this.clip);this.clip.setBounds(layout.clip);this.view.setBounds(layout.page);this.webContents.setZoomFactor(layout.zoom);this.view.setVisible(true);this.clip.setVisible(true);if(first)this.webContents.focus();
  }
  setInlineBounds(bounds){
    if(this.isDestroyed()||!this.inline)return;
    if(bounds===null){this.slot=null;this.clip.setVisible(false);return;}
    const win=this.parent();if(!win||win.isDestroyed())return;const viewport=win.getContentBounds(),zoom=win.webContents.getZoomFactor();
    if(!bounds||!['x','y','width','height'].every(k=>Number.isFinite(bounds[k])))throw new Error('验证窗口位置无效');
    const b=Object.fromEntries(Object.entries(bounds).map(([k,v])=>[k,Math.floor(v*zoom)]));
    if(b.x<0||b.y<50||b.width<150||b.height<100||b.x+b.width>viewport.width+1||b.y+b.height>viewport.height+1)throw new Error('验证窗口超出软件范围');
    this.slot=b;this.layoutPanel();
  }
  openExternal(){if(this.isDestroyed())return;this.inline=false;this.slot=null;this.detachClip();this.move(this.host.contentView);this.onVisibility(false,this.webContents.id);this.webContents.setZoomFactor(1);const b=this.host.getContentBounds();this.view.setBounds({x:0,y:0,width:b.width,height:b.height});this.view.setVisible(true);this.host.setSkipTaskbar(false);this.host.show();this.host.focus();}
  close(){if(this.closed)return;this.closed=true;clearInterval(this.panelTimer);this.detachClip();this.owner?.removeChildView(this.view);if(!this.webContents.isDestroyed())this.webContents.close({waitForBeforeUnload:false});if(!this.host.isDestroyed())this.host.destroy();this.onVisibility(false,null);this.emit('closed');}
}
