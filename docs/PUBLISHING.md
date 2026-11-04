# 发布清单（GitHub → DSH 插件市场）

## 1. 仓库

```bash
git remote add origin git@github.com:<你的账号>/dsh-plugin-sync.git
git push -u origin main
git tag v1.0.0 && git push --tags
```

建议默认分支 `main`；`.gitignore` 已排除 `node_modules/`、日志与测试临时目录（`tests/tmp/`）。

## 2. `package.json` 需要补的字段

当前已有：`name`（`dsh-plugin-sync`，与 bundle 行 id 一致）、`version`、`type`、`exports`（`./locale/*.json`、`./icon`）、`files`、`dsh.bundle.patch`、`license`、`keywords`、`engines.node`。

上传前再补：

- `repository` / `homepage` / `bugs`（市场页会展示）
- `author`
- 如果面向官方 STORE 提交：`engines.dsh` 或 `dsh.compatibility.dshReleases`（按目标 DSH 版本逐项声明 compatible，不要写宽泛范围凑数）
- 需要 npm 发布时确认 `name` 未被占用（当前不带 scope，属于通用名）

## 3. 打包自检

```bash
npm pack --dry-run       # 确认 files 白名单：index.js / lib/*.js / hub.mjs / cordis.patch.yml / locale/*.json / icon.svg / README
node --check index.js && node --check hub.mjs && for f in lib/*.js; do node --check "$f"; done
node tests/engine.test.mjs      # 必须 ALL PASS
```

展示资源自检（市场会读）：

- `locale/en.json`、`locale/zh.json` 都有 `meta.title` / `meta.description`，且描述与功能一致
- `icon.svg` 是有效 SVG、≤ 256 KiB、留在包目录内
- `cordis.patch.yml` 里 `- id: dsh-plugin-sync` 这一行**不能写行尾注释**（提交预检按行抓取 entry id）

## 4. 版本与变更

- 遵循 semver：行为/配置字段不兼容 → major；新增功能 → minor；修复 → patch
- 每次发版更新 `version`、打 tag，并在 GitHub Release 里写清配置变化
- 替换已安装版本后，DSH 需重启才能载入新的 JavaScript 代际

## 5. 安全

- 仓库里**不要**提交任何 `config.json`、token、`~/.dsh` 数据或日志
- 示例配置只用占位 token（如 `<TOKEN>`），真实 token 由用户在本机生成：`openssl rand -hex 24`
- README 已说明：token 为空时只绑定 `127.0.0.1`，局域网同步必须设置 token
