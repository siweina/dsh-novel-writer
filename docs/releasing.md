# 本地发布检查

这份说明对应当前仓库的 GitHub Actions 发布链路。当前工作只完成本地修复、构建和测试，不会自动推送 GitHub、创建 Release 或发布 npm。

## 本地验证

```bash
npm ci
npm run check
```

`npm run check` 会检查客户端构建产物、版本号一致性、主页和工具文档版本，以及全部回归测试。其中 `node tools/check-release.mjs` 的三条硬门禁与本站直接相关：① `package.json` / `package-lock.json` / `server.json` 三处版本必须与 `CHANGELOG.md` 的当前小节一致；② `lib/core.js` 的 `ALL_TOOLS` 必须是 **22 个**（工具数文案漂移会在这里被挡住）；③ `docs/index.html`、`docs/tools/index.html` 与**每一个** `docs/tools/novel-*.html` 的 JSON-LD `softwareVersion` 都必须等于 `package.json` 的版本——发版前请确认站点侧已翻到同一版本号。

## GitHub Actions

`.github/workflows/release.yml` 在 `v*`（如 `v7.3.5`）这类 tag 上执行测试、生成 ZIP 和 npm tarball，然后才进入发布步骤。普通分支、Pull Request 和手动运行（`workflow_dispatch`）只做测试、打包与凭据自检，不发布 npm。

## npm 发布认证与流程

npm 发布认证使用仓库 Secret `NPM_TOKEN`（通过 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` 注入），不再依赖 npm OIDC Trusted Publishing：

- `package` 作业在 `workflow_dispatch` 与 `v*` tag 运行时都会用 `NPM_TOKEN` 执行 `npm whoami --registry https://registry.npmjs.org/` 做凭据自检，提前区分「凭据问题」与「打包问题」；
- 仅在推送 `v*` tag 时执行 `npm publish`、提取 release notes 并创建 GitHub Release；
- `mcp-registry` 作业（`.github/workflows/publish-mcp.yml`）会在 `package` 作业之后等待该版本在 npm 可见，再使用 GitHub OIDC（`id-token: write`）登录并发布到官方 MCP Registry。

配置完成后，先在 GitHub Actions 用 `workflow_dispatch` 验证测试、打包产物与 `NPM_TOKEN` 凭据自检；确认无误，再由维护者创建匹配 `package.json` 的版本 tag。不要把 `NPM_TOKEN` 写入仓库文件或 workflow。
