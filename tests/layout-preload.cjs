const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('cangxia',{state:()=>ipcRenderer.invoke('layout:state'),onChange:()=>()=>{}});
