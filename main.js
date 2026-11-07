/**
 * Electron 主进程：创建窗口，加载共享的「网站」UI，
 * 提供下载目录管理 + 原生下载（含进度回传）。
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 下载目录配置保存在 userData（随系统用户走，不污染项目目录）
function configPath() {
    return path.join(app.getPath('userData'), 'silogu-config.json');
}

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    } catch (err) {
        return {};
    }
}

function writeConfig(cfg) {
    try {
        fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
    } catch (err) {
        // 配置目录不可写时不致命，退回到默认下载目录
    }
}

function defaultDownloadDir() {
    return app.getPath('downloads');
}

function getDownloadDir() {
    const cfg = readConfig();
    return cfg.downloadDir || defaultDownloadDir();
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        backgroundColor: '#0a0e1a',
        title: '小龙果',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    // 加载和网页完全一致的 UI，保证「网页和应用统一」
    win.loadFile(path.join(__dirname, '..', '网站', 'index.html'));

    // 窗口加载完成后再显示，避免白屏闪烁
    win.once('ready-to-show', function () {
        win.show();
    });

    // 外部链接交给系统浏览器，不在应用内跳转
    win.webContents.setWindowOpenHandler(function (detail) {
        if (detail.url && /^https?:/i.test(detail.url)) {
            shell.openExternal(detail.url);
        }
        return { action: 'deny' };
    });
}

app.whenReady().then(function () {
    // 读取当前下载目录
    ipcMain.handle('get-download-dir', function () {
        return getDownloadDir();
    });

    // 弹出系统目录选择框
    ipcMain.handle('choose-download-dir', async function (event) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            title: '选择下载目录',
            properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled || !result.filePaths || !result.filePaths.length) {
            throw new Error('cancelled');
        }
        const dir = result.filePaths[0];
        const cfg = readConfig();
        cfg.downloadDir = dir;
        writeConfig(cfg);
        return dir;
    });

    // 原生下载：交 Electron 下载到设定目录，并把进度 / 结果回传给页面的进度条
    ipcMain.handle('download-file', function (event, payload) {
        const url = payload && payload.url;
        const filename = (payload && payload.filename) || 'download';
        const dir = getDownloadDir();
        const win = BrowserWindow.fromWebContents(event.sender);
        const ses = win.webContents.session;

        return new Promise(function (resolve, reject) {
            // 先挂监听，再触发下载，避免漏掉 will-download 事件
            ses.once('will-download', function (evt, item) {
                item.setSavePath(path.join(dir, filename));

                item.on('updated', function (e, state) {
                    if (state === 'interrupted') {
                        win.webContents.send('download-error', { message: '下载被中断' });
                        reject(new Error('下载被中断'));
                    } else if (state === 'progressing') {
                        win.webContents.send('download-progress', {
                            received: item.getReceivedBytes(),
                            total: item.getTotalBytes()
                        });
                    }
                });

                item.once('done', function (e, state) {
                    if (state === 'completed') {
                        const finalPath = item.getSavePath();
                        win.webContents.send('download-done', { path: finalPath });
                        resolve({ path: finalPath });
                    } else if (state === 'cancelled') {
                        win.webContents.send('download-error', { message: '下载已取消' });
                        reject(new Error('下载已取消'));
                    } else {
                        win.webContents.send('download-error', { message: '下载失败：' + state });
                        reject(new Error('下载失败：' + state));
                    }
                });
            });

            win.webContents.downloadURL(url);
        });
    });

    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});