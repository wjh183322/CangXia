const { contextBridge, ipcRenderer } = require('electron');
const methods = ['flatPrepare','flatStart','flatPause','flatResume','flatRetry','flatCancel','flatClear','flatOpen','state','openAccount','startQrLogin','refreshQrLogin','cancelQrLogin','showQrLoginPage','checkQrLogin','setQrPageBounds','showQrExternalPage','finishLogin','logout','importLoginConfig','sync','stopSync','addCollections','importLink','download','pause','resume','cancelDownloads','repairVideoCover','setDownloadConcurrency','chooseRoot','openRoot','openFolder','openOriginal','prepareDelete','prepareNASRemoval','confirmNASRemoval','cancelNASRemoval','resumeNASRemoval','cancelLocalRemoval','confirmDelete','checkRepairs','startRepairs','pickerLocations','listDirectory','makeDirectory','setTags','checkSource','refreshFiles','clearCompleted','confirmLegacyAccount','openDiagnostics'];
const api = {};
methods.push('stopWorkCreators','refreshWorkCreators','configureBackup','checkBackup','syncBackup','cancelBackup','acceptRemoteBackup','openBackupRecovery','previewExistingLibrary','importExistingLibrary','finishBackupExit');
methods.push('startupReady','confirmCollectionRead');
methods.push('addAuthor','readAuthor','archiveAuthor');
methods.push('inspectDefects','startDefectRepair','resumeDefectRepair','stopDefectRepair');
methods.push('reportCoverStatus');
let statePending=null;
for (const method of methods) api[method] = async (...args) => {
  const result = await ipcRenderer.invoke('cangxia:' + method, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const fetchState=api.state;
api.state=()=>{
  if(!statePending)statePending=(async()=>{const state=await fetchState();if(!state.chunkedState)return state;const works=[];while(works.length<state.total){const result=await ipcRenderer.invoke('cangxia:stateChunk',state.token,works.length);if(!result.ok)throw new Error(result.error);if(!result.data.works.length)throw new Error('界面数据未完整返回');works.push(...result.data.works);}return {...state.head,works};})().finally(()=>{statePending=null;});
  return statePending;
};
api.onChange = callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('cangxia:change', listener); return () => ipcRenderer.removeListener('cangxia:change', listener); };
api.onExitRequested=callback=>{const listener=()=>callback();ipcRenderer.on('cangxia:exit-requested',listener);return()=>ipcRenderer.removeListener('cangxia:exit-requested',listener);};
api.onNotice = callback => {const listener=(_event,message)=>callback(message);ipcRenderer.on('cangxia:notice',listener);return()=>ipcRenderer.removeListener('cangxia:notice',listener);};
contextBridge.exposeInMainWorld('cangxia', Object.freeze(api));
