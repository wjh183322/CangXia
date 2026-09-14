const { contextBridge, ipcRenderer } = require('electron');
const methods = ['state','openAccount','startQrLogin','refreshQrLogin','cancelQrLogin','showQrLoginPage','finishLogin','importLoginConfig','sync','stopSync','addCollections','importLink','download','pause','resume','chooseRoot','openRoot','openFolder','openOriginal','prepareDelete','confirmDelete','checkRepairs','startRepairs','listDirectory','makeDirectory','setTags','checkSource','refreshFiles','clearCompleted'];
const api = {};
methods.push('configureBackup','checkBackup','syncBackup','cancelBackup','acceptRemoteBackup','openBackupRecovery','previewExistingLibrary','importExistingLibrary','finishBackupExit');
for (const method of methods) api[method] = async (...args) => {
  const result = await ipcRenderer.invoke('cangxia:' + method, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
api.onChange = callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('cangxia:change', listener); return () => ipcRenderer.removeListener('cangxia:change', listener); };
api.onExitRequested=callback=>{const listener=()=>callback();ipcRenderer.on('cangxia:exit-requested',listener);return()=>ipcRenderer.removeListener('cangxia:exit-requested',listener);};
contextBridge.exposeInMainWorld('cangxia', Object.freeze(api));
