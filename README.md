# DeepSeek Harness 桌面版

这是面向普通 Windows 用户的非官方社区桌面发行版。它封装官方
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，最终用户不需要安装
Node.js，也不需要打开命令行。

当前桌面版为 0.3.0，内置官方 @deepseek-ai/dsh@0.1.1-rc.2。

## 安装与使用

- x64 与 ARM64 分别提供完整安装 EXE。
- 默认安装到 D:\DeepSeek Harness Desktop；D 盘不满足本机固定磁盘、NTFS、可写和
  1 GiB 可用空间要求时，回退到当前用户应用目录。高级安装可手动更改位置。
- 安装后创建桌面和开始菜单快捷方式，不要求管理员权限。
- 首次启动按图形向导填写 API Key、选择工作区、模式和权限。
- 程序目录、Harness 数据目录、工作区是三个独立位置，设置中心会分别显示。

API Key 板块支持：

- 对新 Key 发起真实 DeepSeek API 连接测试，测试不会保存输入；
- 对已保存 Key 重新测试；
- 测试成功并保存新 Key 后，原子替换旧密文；
- 显式删除 Key，不会因输入框留空而误删；
- 由 Electron safeStorage 调用 Windows DPAPI，密文仅绑定当前 Windows 账户。

## 桌面功能

- 普通模式和 Plan 模式；Plan 只通过官方 /plan 命令应用于新会话，不改已有会话。
- 只读、工作区写入和 Full Access。Full Access 会关闭沙箱及逐项批准，因此每次启动都要
  重新确认，确认状态不会保存。
- 工作区真实路径、junction、系统目录、根目录、云盘、网络盘和可写性预检。
- Harness 数据目录校验迁移，复制后逐文件 SHA-256 校验，原目录保留。
- 插件发现、来源/完整性/兼容性/能力审查、安装脚本阻断、安装、更新、启停、卸载、回滚和
  安全模式。安装、更新或卸载失败会恢复完整 `node_modules` 与配置，进程中断后也会按事务日志恢复。
- 浅色、深色和跟随系统主题；开机启动、托盘、通知、崩溃恢复和诊断模式。
- 本机数据备份/恢复、恢复中断日志、脱敏诊断导出、日志轮转、运行环境检查和二次确认清除。
- 完整桌面包更新、下载进度、稍后安装、升级前数据快照和上一版程序回滚；新版本健康检查失败
  时保留恢复快照，由用户在更新板块手动恢复。

## 与官方项目的关系

本项目不修改 DeepSeek Harness 智能体核心，也不代表 DeepSeek 官方。官方仓库面向开发者，
通常通过 Node.js、包管理器和命令行安装；本项目增加 Electron 窗口、Windows 安装器、
DPAPI 凭据管理、更新/回滚、插件审查和本机数据工具。

社区中的其它安装包可能使用不同核心版本、更新源、权限默认值和凭据保存方式。比较时应核对：

- 是否固定并公开内置 Harness 版本；
- 是否能复现依赖闭包并发布 SBOM、第三方许可和 SHA-256；
- 是否默认最小权限、真实测试 Key、阻断插件安装脚本；
- 是否整包更新并保留可回滚上一版，而不是在线热替换核心；
- 是否清楚标注非官方身份、未签名状态和数据位置。

DeepSeek 名称及标识归其权利人所有。本项目的社区发行说明不能理解为官方背书。

## 数据与安全边界

默认位置：

- 程序：D:\DeepSeek Harness Desktop
- 桌面设置：当前用户 Electron userData 下的 desktop-config.json
- Harness 数据：当前用户 Electron userData\harness，或用户选择的空目录
- 日志：Electron 当前用户日志目录
- 工作区：用户单独选择的项目目录

DPAPI 可防止密文配置被离线复制后直接读取，但不能防止同一 Windows 账户下运行的恶意程序。
Key 在调用 API 和启动 Harness 时也必须短暂存在于进程内存及 Harness 环境变量中。替换本机
Key 不会撤销服务端旧 Key，怀疑泄露时仍需到 DeepSeek 平台撤销并轮换。

安装器会移除程序目录继承的宽泛写权限，但不会改写整个 D 盘根目录的 ACL。若电脑由多个互不
信任的本地账户共用，且 D 盘根目录允许这些账户删除其它目录，应先由管理员为安装位置建立仅
当前用户可修改的父目录；普通单用户电脑不需要额外操作。

普通数据备份包含会话内容，备份本身不加密。SHA-256 清单用于发现传输损坏，不是对抗恶意篡改
的数字签名。历史备份可能保留旧 DPAPI 密文，应按敏感数据保管或删除。

Full Access 对应官方 danger-full-access，会关闭沙箱和逐项批准。推荐日常使用“工作区写入”。
第三方插件会在 Harness 进程中运行，社区主题和精选列表不代表官方或本项目审核背书。

## 更新与发布

桌面版只通过完整安装包更新，绝不在运行中单独替换 Harness npm 包。构建时任选一种更新源：

~~~powershell
$env:DSH_DESKTOP_UPDATE_URL = 'https://updates.example.com/deepseek-harness-desktop'
npm run build
~~~

或在 GitHub Actions / 本机设置 GITHUB_REPOSITORY=owner/repository，由 electron-builder 生成
GitHub Releases 更新配置。发布服务器必须同时提供安装包、blockmap 和 latest.yml /
preview.yml。没有配置发布源的安装包仍可手动覆盖安装，但“自动检查桌面版”会明确显示未配置。

按产品要求，本版本**不做 Windows 代码签名**。安装包会显示“未知发布者”，并可能触发
SmartScreen。更新包仍使用 HTTPS 和 electron-builder 清单中的 SHA-512 做传输完整性检查，
但这不等同于 Authenticode 发布者身份验证。

每次发布会生成：

- x64 与 ARM64 安装 EXE、blockmap 和更新清单；
- SHA256SUMS.txt 与 release-manifest.json；
- CycloneDX SBOM；
- 第三方许可汇总。

GitHub Actions 构建的 `release-manifest.json` 还记录仓库、40 位提交 SHA 和 Git ref，便于把发布
产物反查到唯一源码版本；本地无 Git 元数据的构建会把这些字段留空。

打包只把 Harness 与 pnpm 的锁定运行时闭包放入解包区；source map 和 TypeScript 类型声明保留在
`app.asar`，不会产生第二份磁盘副本。发布校验会拒绝缺包、混用 Harness 版本、错误 CPU 架构、
意外解包的构建期文件，以及与当前工作树内容不一致的陈旧应用文件。

## 开发与验证

要求 Windows 10/11 和 Node.js 24：

~~~powershell
npm ci
npm audit --omit=dev --audit-level=high
npm test
npm run verify
npm run test:dsh
npm start
~~~

`npm run test:dsh` 会从官方 `0.1.0-rc.7` 生成的无凭据固定夹具恢复旧工作区、旧会话、权限、
Plan 状态和工具调用记录，再验证当前核心创建的新会话可在重启后读取。

构建：

~~~powershell
npm run build:x64
npm run build:arm64
npm run build
~~~

最终 x64 EXE 还可执行完整安装烟测：

~~~powershell
npm run test:installer
node scripts/capture-ui.cjs "release\win-unpacked\DeepSeek Harness Desktop.exe"
~~~

安装烟测会修改当前 Windows 用户的安装注册表和快捷方式，因此发现既有正式安装时会直接拒绝；
它在干净环境中验证静默安装、同版本修复、桌面/开始菜单快捷方式、精确应用注册表标识，以及
“保留数据”和“同时删除数据”两种卸载结果；若安装中断，只清理能够证明属于本次隔离测试的残留。
界面截图同时覆盖 360 CSS 像素宽、200% 缩放和 Windows 高对比度，并在关键控件不可见、截图疑似
空白或出现横向溢出时失败。生产依赖审计和上述打包版界面检查均已接入 Windows CI。

产物位于 release。x64 文件名示例：
DeepSeek-Harness-Desktop-Setup-0.3.0-x64.exe。
