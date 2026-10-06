# 6.3.0 本地发布检查

这份说明对应当前仓库的 GitHub Actions 发布链路。当前工作只完成本地修复、构建和测试，不会自动推送 GitHub、创建 Release 或发布 npm。

## 本地验证

```bash
npm ci
npm run check
```

`npm run check` 会检查客户端构建产物、版本号一致性、主页和工具文档版本，以及全部回归测试。其中 `node tools/check-release.mjs` 的三条硬门禁与本站直接相关：① `package.json` / `package-lock.json` / `server.json` 三处版本必须与 `CHANGELOG.md` 的当前小节一致；② `lib/core.js` 的 `ALL_TOOLS` 必须是 **19 个**（工具数文案漂移会在这里被挡住）；③ `docs/index.html` 与**每一个** `docs/tools/novel-*.html` 的 JSON-LD `softwareVersion` 都必须等于 `package.json` 的版本——发版前请确认站点侧已翻到同一版本号。

## GitHub Actions

`.github/workflows/release.yml` 在 `v6.3.0` 这类 tag 上执行测试、生成 ZIP 和 npm tarball，然后才进入发布步骤。普通分支、Pull Request 和手动运行只做测试和打包，不发布 npm。

## npm Trusted Publishing

发布链路已改为 npm OIDC Trusted Publishing，不再依赖过期的 `NPM_TOKEN`。在 npm 包 `dsh-novel-writer` 的 Trusted Publisher 设置中填写：

- Provider: GitHub Actions
- Organization or user: `siweina`
- Repository: `dsh-novel-writer`
- Workflow filename: `release.yml`
- Environment name: 留空（当前 workflow 未使用 GitHub Environment）

仓库 workflow 已授予 `id-token: write`，并使用 npm 11.19.0。只有带 `v*` tag 的发布运行会执行 `npm publish`；MCP Registry 发布会等待该版本在 npm 可见后再使用 GitHub OIDC 登录。

配置完成后，先在 GitHub Actions 用 `workflow_dispatch` 验证测试与打包产物；确认无误，再由维护者创建匹配 `package.json` 的版本 tag。不要把 npm token 写入仓库文件或 workflow。
