/**
 * 生成 update.json（增量更新清单）
 * 构建完成后执行：node scripts/build-update-manifest.js
 * 清单里记录每个文件的目标路径、下载地址和 sha256，
 * 应用启动时对比本地文件哈希，只下载不一致的那几个。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const appRoot = path.join(__dirname, '..');
const siteRoot = path.join(appRoot, '..', '网站');
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));

// 两个 GitHub 仓库的 raw 地址（jsDelivr 镜像由应用端自动尝试）
const APP_RAW = 'https://raw.githubusercontent.com/xlg0722/siloguApp/main/';
const SITE_RAW = 'https://raw.githubusercontent.com/xlg0722/siloguWebsite/main/';
const INSTALLER = 'https://gitee.com/silogu/silogu-app/releases/download/v' +
    pkg.version + '/siloguAppSetup.exe';

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, prefix) {
    const out = [];
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
        const full = path.join(dir, entry.name);
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
            walk(full, rel).forEach(function (item) { out.push(item); });
        } else {
            out.push(rel);
        }
    });
    return out;
}

const files = [];

// 应用自身文件：打包后在 resources/app/ 下
// package.json 会被 electron-builder 裁剪过，不能参与哈希比对，所以不列进来
['main.js', 'preload.js'].forEach(function (name) {
    const full = path.join(appRoot, name);
    if (!fs.existsSync(full)) return;
    files.push({
        target: 'resources/app/' + name,
        url: APP_RAW + name,
        sha256: sha256(full)
    });
});

// 网站文件：打包后在 resources/网站/ 下
walk(siteRoot, '').forEach(function (rel) {
    const full = path.join(siteRoot, rel);
    files.push({
        target: 'resources/网站/' + rel,
        url: SITE_RAW + rel,
        sha256: sha256(full)
    });
});

const electronVersion = (function () {
    try {
        return require(path.join(appRoot, 'node_modules', 'electron', 'package.json')).version;
    } catch (err) {
        return '';
    }
})();

const manifest = {
    version: pkg.version,
    electron: electronVersion,
    notes: '增量更新：只下载修改过的文件',
    installer: INSTALLER,
    files: files
};

fs.writeFileSync(path.join(appRoot, 'update.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('update.json 已生成：' + files.length + ' 个文件，版本 ' + pkg.version);
