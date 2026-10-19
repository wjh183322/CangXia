const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cangxia',{state:()=>ipcRenderer.invoke('logs:state'),onChange:()=>()=>{},readHistoryRuns:()=>ipcRenderer.invoke('logs:runs'),readHistoryItems:(token,options)=>ipcRenderer.invoke('logs:items',token,options),sync:()=>ipcRenderer.invoke('logs:sync')});
