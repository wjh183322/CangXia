const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cangxia',{state:()=>ipcRenderer.invoke('layout:state'),onChange:()=>()=>{},audioPrepare:()=>ipcRenderer.invoke('layout:audio'),audioRelease:async()=>true,audioRenew:async()=>true});
