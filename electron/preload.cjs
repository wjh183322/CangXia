const { contextBridge, ipcRenderer } = require('electron');
const methods = [
  'addAuthor', 'addCollections', 'archiveAuthor', 'audioCancel', 'audioPage', 'audioPause',
  'audioPrepare', 'audioRefresh', 'audioRelease', 'audioRenew', 'audioResume', 'audioSave',
  'audioStatus', 'cacheClear', 'cacheSettings', 'cacheStop', 'cancelBackup', 'cancelDownloads',
  'cancelFileCheck', 'cancelQrLogin', 'cancelRepairs', 'cancelStorageSize', 'catalogueAction', 'catalogueChoices',
  'cataloguePosition', 'checkRepairs', 'checkSource', 'clearCompleted', 'clearReadHistory', 'confirmCollectionRead',
  'confirmRemoval', 'controlRead', 'controlRemoval', 'controlTrashProbe', 'defectOverview', 'defectPage',
  'download', 'downloadPage', 'exportWorkDiagnostic', 'finishLogin', 'flatCancel', 'flatClear',
  'flatOpen', 'flatPause', 'flatPrepare', 'flatResume', 'flatRetry', 'flatStart',
  'historyItems', 'importLink', 'inspectDefects', 'listDirectory', 'listWorks', 'logout',
  'makeDirectory', 'markSourceUnavailable', 'openCache', 'openDiagnostics', 'openOriginal', 'pause',
  'pickerLocations', 'downloadBatch', 'previewDownloadSelection', 'previewDownloads', 'previewRemoval', 'previewRestore', 'readAuthor',
  'readHistoryItems', 'readHistoryRuns', 'refreshFiles', 'refreshQrLogin', 'refreshStorageSize', 'refreshWorkCreators',
  'removalHistory', 'removalStatus', 'repairPage', 'repairVideoCover', 'reportCoverStatus', 'resolveSelection',
  'restoreRemoval', 'resume', 'resumeDefectRepair', 'resumeReconcile', 'retryDownloads', 'serverCommand',
  'serverConnect', 'serverGateReady', 'serverIdentity', 'serverReceipt', 'serverRelease', 'serverSession',
  'setDownloadConcurrency', 'setTags', 'showQrExternalPage', 'sourceLoginView', 'sourceManualLogin', 'sourceQrShown',
  'startDefectRepair', 'startQrLogin', 'startRead', 'startRepairs', 'startTrashProbe', 'startupReady',
  'state', 'stopDefectRepair', 'stopSync', 'stopWorkCreators', 'storageUsage', 'sync',
  'trashStatus', 'validateDefectSelection', 'validateDownloadSelection', 'verificationManual', 'verificationView', 'verifySources',
  'workDetail', 'serverRehearsal'
];
const api = {
  windowRole: typeof process === 'undefined' ? '' : process.argv.find(value=>value.startsWith('--cangxia-window='))?.slice(17)
};
for(const method of methods)api[method]=async(...args)=>{
  const result=await ipcRenderer.invoke('cangxia:'+method,...args);
  if(!result.ok)throw Error(result.error);
  return result.data;
};
const fetchState=api.state;
let statePending;
api.state=()=>statePending??=fetchState().finally(()=>{statePending=null;});
for(const [method,channel] of Object.entries({onChange:'change',onNotice:'notice',onServerSession:'server-session'})){
  api[method]=callback=>{
    const listener=(_event,value)=>callback(value);
    ipcRenderer.on('cangxia:'+channel,listener);
    return ()=>ipcRenderer.removeListener('cangxia:'+channel,listener);
  };
}
contextBridge.exposeInMainWorld('cangxia',Object.freeze(api));
