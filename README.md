# BWatch Monitor

独立的 B站多路直播工具：本地收藏、自定义房间、关注列表、纯音频、实时弹幕与 Super Chat。

网站是静态页面，搭配 Chrome/Edge 浏览器扩展直接访问 B站；没有自建业务服务器、数据库或账号托管。

## 使用

打开 [BWatch Monitor](https://dumpling233.github.io/bwatch-monitor/)，在设置中下载扩展 ZIP。

1. 将 ZIP 解压到固定目录，保留该目录。
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，启用开发者模式。
3. 选择“加载已解压的扩展”，选中包含 `manifest.json` 的目录。
4. 返回网站，等待连接成功；添加房间号或 B站直播间链接即可观看。
5. 如需关注列表、账号画质或主动发言，先在 B站登录，再通过扩展窗口确认本站账号授权。

文件安装不会自动更新。更新时下载新版，替换原解压目录文件，并在扩展页点击“重新加载”；网站以实际连接版本确认更新。Firefox、移动端扩展和跨设备同步暂不支持。

收藏、布局和偏好只保存在当前浏览器。新站不读取旧 BWatch 的收藏或授权；清除站点数据会重置配置。Cookie 只在本机扩展内部使用，不导出给网页、不上传到本项目服务器。

GitHub Pages 的同一账号下项目共享网站来源；部署时应信任该账号下的其他网页。需要与其他项目隔离浏览器存储时，请配置独立域名并同步重建扩展。

## 本地开发

需要 Node.js 22+。

```sh
npm ci
npm ci --prefix extension
npm run build:extension:local
npm run dev
```

从 `extension/.output/` 加载开发版解压目录，访问 `http://127.0.0.1:5173/`。开发版只额外允许明确的本地地址；生产版限定部署站点。

```sh
npm test
npm --prefix extension test
npm --prefix extension run typecheck
npm run build:release
npx playwright install chromium
npm run test:e2e
```

`build:release` 生成生产扩展 ZIP、带大小与 SHA-256 的静态下载清单及 `dist/` 网站。GitHub Actions 将 `dist/` 部署到 Pages。更换托管地址时统一修改 `shared/site.ts`，同时重建网站和扩展；项目路径必须一并匹配。

## 架构与边界

| 目录 | 职责 |
|---|---|
| `client/` | React 界面、播放器、弹幕 Worker、本地收藏与偏好 |
| `extension/` | 固定业务请求、账号授权、Cookie 隔离与请求预算 |
| `shared/` | 站点配置、消息契约与播放解析 |
| `scripts/` | 可复现分发、完整性校验和独立性检查 |

完整观看功能要求安装扩展，匿名观看不要求登录 B站。视频、音频、图片与弹幕直接来自 B站；画质、播放格式及接口可用性受上游返回、浏览器能力和风控影响，没有服务器代理兜底。高并发多路播放会占用本机网络、CPU 和内存。

本项目从 BWatch monitor 选择性迁出，独立构建和发布。原项目的后端、历史采集与数据库不属于本项目。

## 许可证

本项目整体采用 [GNU AGPL-3.0](LICENSE)（SPDX：`AGPL-3.0-only`）。分发本项目及其修改版，或通过网络向用户提供修改版服务时，应按协议履行保留许可、提供对应源码等义务；完整条款以 `LICENSE` 为准。

原 BWatch 迁入代码的 MIT 版权与许可告知保留在 [NOTICE](NOTICE)，第三方依赖继续使用各自许可证。网站和扩展安装包均附带 `LICENSE`、`NOTICE` 与 `THIRD_PARTY_LICENSES.txt`；项目源码和构建脚本可从[本仓库](https://github.com/dumpling233/bwatch-monitor)获取。弹幕依赖的必要补丁位于 `patches/`，原第三方说明保留在 `public/third-party-danmaku.txt`。

`licenses/` 保存部分 npm 包缺失的上游许可正文离线副本，构建时生成第三方许可合集，无需联网获取。
