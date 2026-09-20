const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('probe',{
 state:()=>ipcRenderer.invoke('probe-state'),
 open:browser=>ipcRenderer.invoke('probe-open',browser),
 run:confirmed=>ipcRenderer.invoke('probe-run',confirmed),
 stop:()=>ipcRenderer.invoke('probe-stop'),
 save:()=>ipcRenderer.invoke('probe-save'),
 onState:callback=>ipcRenderer.on('probe-state',(_event,state)=>callback(state))
});
