/**
 * Electron 主进程：创建窗口，加载共享的「网站」UI，
 * 提供下载目录管理 + 原生下载（含进度回传）。
 * 自动更新：读取 update.json 清单，只下载被修改过的文件并原地替换。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 更新清单：放在应用仓库根目录，按文件列出 sha256
const UPDATE_MANIFEST_URLS = [
    'https://raw.githubusercontent.com/xlg0722/siloguApp/main/update.json',
    'https://gitee.com/silogu/silogu-app/raw/main/update.json'
];

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
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
            signal: controller.signal
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// raw.githubusercontent 在国内常被墙，失败时换成 jsDelivr 镜像
function mirrorUrl(url) {
    const match = String(url || '').match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/main\/(.+)$/);
    if (!match) return null;
    return 'https://cdn.jsdelivr.net/gh/' + match[1] + '/' + match[2] + '@main/' + match[3];
}

async function fetchJsonAny(urls) {
    let lastErr = null;
    for (let i = 0; i < urls.length; i++) {
        try {
            return await fetchJson(urls[i]);
        } catch (err) {
            lastErr = err;
            logUpdate('清单请求失败 ' + urls[i] + '：' + err.message);
        }
    }
    throw lastErr || new Error('没有可用的清单地址');
}

// 下载单个文件，失败时同样尝试镜像
async function downloadBuffer(url) {
    const candidates = [url];
    const alt = mirrorUrl(url);
    if (alt) candidates.push(alt);

    let lastErr = null;
    for (let i = 0; i < candidates.length; i++) {
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, 60000);
        try {
            const res = await net.fetch(candidates[i], { signal: controller.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return Buffer.from(await res.arrayBuffer());
        } catch (err) {
            lastErr = err;
            logUpdate('下载失败 ' + candidates[i] + '：' + err.message);
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr || new Error('下载失败');
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function manifestUrls() {
    const list = UPDATE_MANIFEST_URLS.slice();
    const alt = mirrorUrl(list[0]);
    if (alt) list.push(alt);
    return list;
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

// 对比本地文件，算出需要替换的清单项
function buildUpdatePlan(manifest) {
    const root = process.resourcesPath;
    const files = [];

    (manifest && manifest.files ? manifest.files : []).forEach(function (entry) {
        if (!entry || !entry.target || !entry.sha256 || !entry.url) return;
        // 只允许替换 resources 目录内的文件，防止清单被篡改后写到系统目录
        if (entry.target.indexOf('..') !== -1) return;
        if (!/^resources[\\/]/.test(entry.target)) return;

        const dest = path.join(root, entry.target);
        let hash = '';
        try {
            hash = sha256File(dest);
        } catch (err) {
            hash = '';
        }
        if (hash === entry.sha256) return;

        files.push({ target: entry.target, url: entry.url, sha256: entry.sha256, dest: dest });
    });

    // Electron 内核变了就必须用完整安装包，不能只换文件
    const runtimeOk = !manifest || !manifest.electron || manifest.electron === process.versions.electron;
    return { files: files, fullRequired: !runtimeOk };
}

// 逐个下载、校验、替换；失败的收集起来交给上层提示
async function applyUpdatePlan(plan) {
    const cacheDir = path.join(app.getPath('userData'), 'update-cache');
    try {
        fs.mkdirSync(cacheDir, { recursive: true });
    } catch (err) {
        // 目录创建失败会在写文件时暴露
    }

    let changed = 0;
    const failed = [];

    for (let i = 0; i < plan.files.length; i++) {
        const item = plan.files[i];
        try {
            const buf = await downloadBuffer(item.url);
            const hash = crypto.createHash('sha256').update(buf).digest('hex');
            if (hash !== item.sha256) throw new Error('文件校验失败');

            const tmp = path.join(cacheDir, 'tmp-' + hash.slice(0, 10));
            fs.writeFileSync(tmp, buf);
            fs.mkdirSync(path.dirname(item.dest), { recursive: true });
            fs.copyFileSync(tmp, item.dest);
            fs.rmSync(tmp, { force: true });

            changed += 1;
            logUpdate('已替换 ' + item.target);
        } catch (err) {
            failed.push({ target: item.target, message: err && err.message ? err.message : String(err) });
            logUpdate('替换失败 ' + item.target + '：' + (err && err.message ? err.message : String(err)));
        }
    }

    return { changed: changed, failed: failed };
}

function openInstaller(manifest) {
    if (manifest && manifest.installer) {
        shell.openExternal(manifest.installer);
    }
}

// 启动后检查更新：有新版本就弹窗，能增量更新就只下修改过的文件
function checkForUpdates(win, retried) {
    if (!app.isPackaged) return;

    const current = app.getVersion();
    logUpdate('检查更新：当前版本 v' + current);

    fetchJsonAny(manifestUrls()).then(function (manifest) {
        if (!manifest || !manifest.version) throw new Error('清单缺少版本号');
        logUpdate('检查更新：清单版本 v' + manifest.version);

        const latest = parseVersion(manifest.version);
        const local = parseVersion(current);
        if (!latest || !local) return;
        if (compareVersions(latest, local) <= 0) {
            logUpdate('检查更新：已是最新版本');
            return;
        }

        const plan = buildUpdatePlan(manifest);
        if (!plan.fullRequired && !plan.files.length) {
            logUpdate('检查更新：新版本没有需要替换的文件');
            return;
        }
        promptUpdate(win, manifest, plan);
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

function promptUpdate(win, manifest, plan) {
    const detail = plan.fullRequired
        ? '这个版本需要完整安装包，点击「下载安装包」后会打开下载页面。'
        : '需要更新 ' + plan.files.length + ' 个文件，更新完成后重启生效。' +
          (manifest.notes ? '\n\n' + String(manifest.notes).slice(0, 300) : '');

    logUpdate('检查更新：发现新版本 v' + manifest.version + '，待更新 ' + plan.files.length + ' 个文件');

    dialog.showMessageBox(win, {
        type: 'info',
        title: '发现新版本',
        message: '小龙果 v' + manifest.version + ' 已发布',
        detail: detail,
        buttons: plan.fullRequired ? ['下载安装包', '稍后'] : ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    }).then(function (result) {
        if (result.response !== 0) return;
        if (plan.fullRequired) {
            openInstaller(manifest);
            return;
        }

        applyUpdatePlan(plan).then(function (res) {
            if (!res.changed) throw new Error('没有文件更新成功');

            dialog.showMessageBox(win, {
                type: res.failed.length ? 'warning' : 'info',
                title: res.failed.length ? '部分文件更新失败' : '更新完成',
                message: res.failed.length ? '部分文件没能替换' : '已更新到 v' + manifest.version,
                detail: '已替换 ' + res.changed + ' 个文件' +
                    (res.failed.length ? '，失败 ' + res.failed.length + ' 个：' + res.failed.map(function (f) { return f.target; }).join('、') : '') +
                    '\n\n重启应用后生效。',
                buttons: res.failed.length ? ['下载安装包', '稍后'] : ['立即重启', '稍后'],
                defaultId: 0,
                cancelId: 1,
                noLink: true
            }).then(function (r) {
                if (res.failed.length) {
                    if (r.response === 0) openInstaller(manifest);
                    return;
                }
                if (r.response === 0) {
                    app.relaunch();
                    app.exit(0);
                }
            });
        }).catch(function (err) {
            logUpdate('更新失败：' + (err && err.message ? err.message : String(err)));
            dialog.showMessageBox(win, {
                type: 'warning',
                title: '更新失败',
                message: '没能完成更新',
                detail: (err && err.message ? err.message : '未知错误') + '\n可以下载完整安装包重新安装。',
                buttons: ['下载安装包', '稍后'],
                defaultId: 0,
                cancelId: 1,
                noLink: true
            }).then(function (r) {
                if (r.response === 0) openInstaller(manifest);
            });
        });
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

    // 设置页「检查更新」：读清单，返回是否需要更新、要替换几个文件
    ipcMain.handle('check-updates', async function () {
        if (!app.isPackaged) {
            return { current: app.getVersion(), latest: app.getVersion(), hasUpdate: false, fileCount: 0, full: false, installer: '' };
        }
        const manifest = await fetchJsonAny(manifestUrls());
        const plan = buildUpdatePlan(manifest);
        const latest = (manifest && manifest.version) || '';
        const latestArr = parseVersion(latest);
        const localArr = parseVersion(app.getVersion());
        const hasUpdate = !!(latestArr && localArr && compareVersions(latestArr, localArr) > 0);
        return {
            current: app.getVersion(),
            latest: latest,
            hasUpdate: hasUpdate,
            fileCount: plan.files.length,
            full: plan.fullRequired,
            installer: (manifest && manifest.installer) || ''
        };
    });

    // 设置页「立即更新」：只下载修改过的文件并替换
    ipcMain.handle('apply-update', async function () {
        if (!app.isPackaged) throw new Error('开发环境不支持更新');
        const manifest = await fetchJsonAny(manifestUrls());
        const plan = buildUpdatePlan(manifest);
        if (plan.fullRequired) {
            return { ok: false, full: true, changed: 0, failed: [], installer: manifest.installer || '' };
        }
        const res = await applyUpdatePlan(plan);
        return {
            ok: !res.failed.length && res.changed > 0,
            full: false,
            changed: res.changed,
            failed: res.failed,
            installer: manifest.installer || ''
        };
    });

    // 更新完成后重启应用
    ipcMain.handle('restart-app', function () {
        app.relaunch();
        app.exit(0);
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
