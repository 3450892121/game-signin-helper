'use strict';
// 仅用于 test:layout：桥接到测试进程内存中的虚构数据，不加载生产主进程。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('app', {
  invoke: (channel, payload) => ipcRenderer.invoke('layout-test:invoke', channel, payload),
  on: () => {},
});
