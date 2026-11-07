; 小龙果 安装包脚本（Inno Setup 6）
; 用法：先执行 npm run dist 生成 dist\win-unpacked，再用 Inno Setup Compiler 编译本文件
; 安装到当前用户目录，不需要管理员权限，应用才能自己写入更新

#define MyAppName "小龙果"
#define MyAppExeName "小龙果.exe"
#define MyAppVersion GetFileVersion("dist\win-unpacked\小龙果.exe")

[Setup]
AppId={{7A5C1B3E-2F64-4C1D-9E0A-5B8D7C3F2A10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=小龙果
DefaultDirName={localappdata}\Programs\小龙果
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 只装到当前用户目录，避免更新文件时需要管理员权限
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=siloguAppSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "其他："; Flags: unchecked

[Files]
Source: "dist\win-unpacked\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent
