import {BaseWindow,WebContentsView} from 'electron';
import {EventEmitter} from 'node:events';

// A single official page moves between a hidden host, an inline slot and a
// detached fallback. Its WebContents (including in-page verification state) stays the same.
export class VerificationView extends EventEmitter {
  constructor({parent,partition,onVisibility}){
    super();this.parent=parent;this.onVisibility=onVisibility;this.closed=false;this.inline=false;
    this.host=new BaseWindow({width:1000,height:800,show:false,skipTaskbar:true,autoHideMenuBar:true,title:'藏匣 · 抖音登录验证'});
    this.view=new WebContentsView({webPreferences:{partition,contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});this.webContents=this.view.webContents;
    this.owner=this.host.contentView;this.owner.addChildView(this.view);this.view.setBounds({x:0,y:0,width:1000,height:760});this.view.setBackgroundColor('#ffffff');
    this.host.on('resize',()=>{if(!this.inline&&!this.closed){const b=this.host.getContentBounds();this.view.setBounds({x:0,y:0,width:b.width,height:b.height});}});
    this.host.on('close',event=>{if(!this.closed){event.preventDefault();this.close();}});
    this.webContents.on('page-title-updated',(...args)=>this.emit('page-title-updated',...args));
    this.webContents.once('destroyed',()=>{if(!this.closed)this.close();});
  }
  move(owner){if(this.owner===owner)return;this.owner?.removeChildView(this.view);owner.addChildView(this.view);this.owner=owner;}
  loadURL(...args){return this.webContents.loadURL(...args);}
  isDestroyed(){return this.closed||this.webContents.isDestroyed();}
  isVisible(){return !this.isDestroyed()&&(this.inline?this.owner===this.parent()?.contentView&&this.view.getVisible()&&this.parent().isVisible():this.host.isVisible());}
  getContentBounds(){const b=this.view.getBounds(),z=this.webContents.getZoomFactor();return {...b,width:b.width/z,height:b.height/z};}
  setTitle(title){this.host.setTitle(title);}
  setSkipTaskbar(value){if(!this.inline)this.host.setSkipTaskbar(value);}
  hide(){if(this.closed)return;this.move(this.host.contentView);this.inline=false;this.view.setBounds({x:0,y:0,width:1000,height:760});this.webContents.setZoomFactor(1);this.host.hide();this.onVisibility(false,this.webContents.id);}
  show(){if(this.closed)return;this.host.hide();this.inline=true;this.onVisibility(true,this.webContents.id);}
  focus(){if(!this.closed&&this.owner===this.parent()?.contentView)this.webContents.focus();}
  setInlineBounds(bounds){
    if(this.isDestroyed()||!this.inline)return;
    if(bounds===null){this.view.setVisible(false);return;}
    const win=this.parent();if(!win||win.isDestroyed())return;const viewport=win.getContentBounds(),zoom=win.webContents.getZoomFactor();
    if(!bounds||!['x','y','width','height'].every(k=>Number.isFinite(bounds[k])))throw new Error('验证窗口位置无效');
    const b=Object.fromEntries(Object.entries(bounds).map(([k,v])=>[k,Math.floor(v*zoom)]));
    if(b.x<0||b.y<50||b.width<150||b.height<100||b.x+b.width>viewport.width+1||b.y+b.height>viewport.height+1)throw new Error('验证窗口超出软件范围');
    const first=this.owner!==win.contentView;this.move(win.contentView);this.view.setBounds(b);this.webContents.setZoomFactor(Math.max(.6,Math.min(1,b.width/1000,b.height/650)));this.view.setVisible(true);if(first)this.webContents.focus();
  }
  openExternal(){if(this.isDestroyed())return;this.move(this.host.contentView);this.inline=false;this.onVisibility(false,this.webContents.id);this.webContents.setZoomFactor(1);const b=this.host.getContentBounds();this.view.setBounds({x:0,y:0,width:b.width,height:b.height});this.view.setVisible(true);this.host.setSkipTaskbar(false);this.host.show();this.host.focus();}
  close(){if(this.closed)return;this.closed=true;this.owner?.removeChildView(this.view);if(!this.webContents.isDestroyed())this.webContents.close({waitForBeforeUnload:false});if(!this.host.isDestroyed())this.host.destroy();this.onVisibility(false,null);this.emit('closed');}
}
