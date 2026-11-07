/**
 * Electron 主进程：创建窗口，加载共享的「网站」UI，
 * 提供下载目录管理 + 原生下载（含进度回传）。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');

// Gitee 发行版接口：启动时用来检测是否有新版本
const RELEASES_API = 'https://gitee.com/api/v5/repos/silogu/silogu-app/releases?page=1&per_page=10';
const DOWNLOAD_BASE = 'https://gitee.com/silogu/silogu-app/releases/download/';

// 更新日志：写进 userData/update.log，方便排查「检测不到新版本」
function updateLogPath() {
    return path.join(app.getPath('userData'), 'update.log');
}

function logUpdate(text) {
    try {
        fs.appendFileSync(updateLogPath(), new Date().toISOString() + ' ' + text + '\n');
    } catch (err) {
        // 写日志失败不影响主流程
    }
}

// JSON 请求：走 Chromium 网络栈（自动使用系统代理），12 秒超时
async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 12000);
    try {
        const res = await net.fetch(url, {
            headers: { Accept: 'application/json' },
            signal: controller.signal
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// 把 v1.0.1 这样的标签解析成 [1, 0, 1]
function parseVersion(text) {
    const match = String(text || '').match(/v?(\d+)\.(\d+)\.(\d+)/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    return 0;
}

// 启动后检查更新：有新版本就弹窗，点「立即下载」交给系统浏览器
// retried 用于标记是否已经重试过，失败 20 秒后只自动再试一次
function checkForUpdates(win, retried) {
    const current = parseVersion(app.getVersion());
    logUpdate('检查更新：当前版本 v' + app.getVersion());

    fetchJson(RELEASES_API).then(function (list) {
        if (!Array.isArray(list) || !list.length) {
            logUpdate('检查更新：接口没有返回发行版');
            return;
        }

        // 接口按创建时间排序，必须按版本号取最大，否则会拿到旧版本
        let latest = null;
        list.forEach(function (rel) {
            const version = parseVersion(rel && rel.tag_name);
            if (!version) return;
            if (!latest || compareVersions(version, latest.version) > 0) {
                latest = { version: version, tag: rel.tag_name, notes: rel.body || '', assets: rel.assets || [] };
            }
        });
        if (!latest) {
            logUpdate('检查更新：发行版里没有可识别的版本号');
            return;
        }
        logUpdate('检查更新：最新版本 ' + latest.tag);

        if (!current) return;
        if (compareVersions(latest.version, current) <= 0) {
            logUpdate('检查更新：已是最新版本');
            return;
        }

        const exeAsset = latest.assets.filter(function (item) {
            return item && item.name && /\.exe$/i.test(item.name);
        })[0];
        const downloadUrl = (exeAsset && (exeAsset.browser_download_url || exeAsset.download_url)) ||
            DOWNLOAD_BASE + latest.tag + '/siloguApp.exe';

        logUpdate('检查更新：发现新版本，弹窗提示');
        dialog.showMessageBox(win, {
            type: 'info',
            title: '发现新版本',
            message: '小龙果 ' + latest.tag + ' 已发布',
            detail: '当前版本 v' + app.getVersion() + '，最新版本 ' + latest.tag +
                (latest.notes ? '\n\n' + String(latest.notes).slice(0, 300) : ''),
            buttons: ['立即下载', '稍后'],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        }).then(function (result) {
            if (result.response === 0) {
                shell.openExternal(downloadUrl);
            }
        });
    }).catch(function (err) {
        logUpdate('检查更新失败：' + (err && err.message ? err.message : String(err)));
        // 网络抖动或代理尚未就绪时，20 秒后再试一次
        if (!retried) {
            setTimeout(function () {
                checkForUpdates(win, true);
            }, 20000);
        }
    });
}

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
    // 开发环境：应用/../网站/index.html；打包后：resources/网站/index.html
    const entry = app.isPackaged
        ? path.join(process.resourcesPath, '网站', 'index.html')
        : path.join(__dirname, '..', '网站', 'index.html');
    win.loadFile(entry);

    // 窗口加载完成后再显示，避免白屏闪烁
    win.once('ready-to-show', function () {
        win.show();
        // 稍等再检测更新，避免和首屏渲染抢资源
        setTimeout(function () {
            checkForUpdates(win);
        }, 2000);
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

    // 读取应用版本号，供设置页展示
    ipcMain.handle('get-app-version', function () {
        return app.getVersion();
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
