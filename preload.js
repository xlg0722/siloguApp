/**
 * preload：在上下文隔离（contextIsolation）下，用 contextBridge
 * 向网页暴露一个受控的 desktopAPI，网页和 Electron 之间的唯一通道。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
    // 标识当前运行在桌面应用里（网页端这个对象不存在）
    isDesktop: true,

    // 读取当前下载目录
    getDownloadDir: function () {
        return ipcRenderer.invoke('get-download-dir');
    },

    // 弹出系统目录选择框，返回新选择的目录
    chooseDownloadDir: function () {
        return ipcRenderer.invoke('choose-download-dir');
    },

    // 下载文件到设定目录（返回 Promise）
    downloadFile: function (payload) {
        return ipcRenderer.invoke('download-file', payload);
    },

    // 订阅原生下载事件
    onDownloadProgress: function (callback) {
        ipcRenderer.on('download-progress', function (event, data) { callback(data); });
    },
    onDownloadDone: function (callback) {
        ipcRenderer.on('download-done', function (event, data) { callback(data); });
    },
    onDownloadError: function (callback) {
        ipcRenderer.on('download-error', function (event, data) { callback(data); });
    }
});