'use strict';
/**
 * 游戏社区签到助手 —— 预加载桥（contextBridge 白名单）
 *
 * 安全约束（安全基线）：
 * - 渲染进程零 Node 权限（sandbox + contextIsolation + nodeIntegration:false）
 * - 只暴露 window.app 上的白名单方法，每个方法内部仅调用固定 IPC 通道
 * - 不暴露 require / process / ipcRenderer 本身 / 任意通道
 * - 事件订阅仅允许白名单事件通道，返回取消订阅函数
 */

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = [
  'settings:load', 'settings:save',
  'games:list', 'games:openUserDir', 'games:reload', 'games:add', 'games:remove',
  'accounts:list', 'accounts:remove', 'accounts:setEnabled', 'accounts:setTime',
  'login:sendSms', 'login:sms',
  'login:webOpen', 'login:webCancel',
  'login:guiOpen', 'login:guiClose',   // t17：浏览器登录界面（本地服务+默认浏览器）
  'login:paste',
  'run:account', 'run:game', 'run:all',
  'logs:recent',
  'results:today', 'results:history', 'calendar:month',
  'notify:test',
  'qqbot:bind:start', 'qqbot:status', 'qqbot:bind:cancel',   // QQ 机器人绑定（临时 WebSocket）
  'system:autostart:get', 'system:autostart:set',
  'system:task:status', 'system:task:sync',
  'scheduler:info',
  'app:info', 'app:quit',
];

const EVENT_CHANNELS = ['event:log', 'event:progress', 'event:webLogin', 'event:guiLogin', 'event:accounts', 'event:games', 'event:visibility'];

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const api = {
  /**
 * 通用白名单调用：invoke(channel, payload) —— channel 必须是白名单通道
 * （与命名空间方法等价，供渲染进程统一封装使用）
 */
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.resolve({ ok: false, error: '非法 IPC 通道：' + channel });
    }
    return ipcRenderer.invoke(channel, payload);
  },
  settings: {
    load: invoke('settings:load'),
    save: invoke('settings:save'),
  },
  games: {
    list: invoke('games:list'),
    openUserDir: invoke('games:openUserDir'),
    reload: invoke('games:reload'),
    add: invoke('games:add'),
    remove: invoke('games:remove'),
  },
  accounts: {
    list: invoke('accounts:list'),
    remove: invoke('accounts:remove'),
    setEnabled: invoke('accounts:setEnabled'),
    setTime: invoke('accounts:setTime'),
  },
  login: {
    sendSms: invoke('login:sendSms'),
    sms: invoke('login:sms'),
    webOpen: invoke('login:webOpen'),
    webCancel: invoke('login:webCancel'),
    guiOpen: invoke('login:guiOpen'),
    guiClose: invoke('login:guiClose'),
    paste: invoke('login:paste'),
  },
  run: {
    account: invoke('run:account'),
    game: invoke('run:game'),
    all: invoke('run:all'),
  },
  logs: {
    recent: invoke('logs:recent'),
  },
  results: {
    today: invoke('results:today'),
    history: invoke('results:history'),
    calendarMonth: invoke('calendar:month'),
  },
  notify: {
    test: invoke('notify:test'),
  },
  qqbot: {
    bindStart: invoke('qqbot:bind:start'),
    status: invoke('qqbot:status'),
    bindCancel: invoke('qqbot:bind:cancel'),
  },
  system: {
    autostart: {
      get: invoke('system:autostart:get'),
      set: invoke('system:autostart:set'),
    },
    task: {
      status: invoke('system:task:status'),
      sync: invoke('system:task:sync'),
    },
  },
  scheduler: {
    info: invoke('scheduler:info'),
  },
  app: {
    info: invoke('app:info'),
    quit: invoke('app:quit'),
  },
  /**
 * 订阅主进程事件（仅白名单通道）
 * @returns {Function} 取消订阅函数
 */
  on(channel, callback) {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error('非法事件通道：' + channel);
    }
    if (typeof callback !== 'function') throw new Error('回调必须是函数');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

// 防御：确保 window.app 上不会意外出现任何非白名单方法
contextBridge.exposeInMainWorld('app', api);
