const { contextBridge, ipcRenderer } = require('electron');
const methods = ['state','openAccount','finishLogin','importLoginConfig','sync','stopSync','addCollections','importLink','download','pause','resume','chooseRoot','openRoot','openFolder','openOriginal','deleteWorks','setTags','checkSource','refreshFiles'];
const api = {};
for (const method of methods) api[method] = async (...args) => {
  const result = await ipcRenderer.invoke('cangxia:' + method, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
api.onChange = callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('cangxia:change', listener); return () => ipcRenderer.removeListener('cangxia:change', listener); };
contextBridge.exposeInMainWorld('cangxia', Object.freeze(api));
