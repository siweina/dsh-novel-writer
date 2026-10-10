# 最小容器：dsh-novel-writer 的 stdio MCP 服务器。
#
# 用途：Glama（https://glama.ai/mcp/servers/siweina/dsh-novel-writer）等 MCP 目录
# 通过「构建容器 → 启动 → 用 JSON-RPC over stdio 读 tools/list」来做内省检查。
# 该检查只需要服务器能起来并回答 initialize + tools/list，
# 不需要书库数据、不需要联网、不需要任何 API Key。
#
# 说明：插件的本地 ONNX 语义引擎（onnxruntime-web）是纯 WASM 实现，
# 因此这里没有原生编译步骤，装完即可跑（代价是 onnxruntime-web 解包约 145 MB、
# 全局安装实测 ~2m48s，属已知成本）。
#
# ── v6.5.0 修正：版本号**不再手写** ──
#
# 此前这里是 `ARG DSH_NOVEL_WRITER_VERSION=6.3.x`（写死的具体版本），靠一句注释提醒「每次发版请同步」。
# 而 6.4.0 / 6.5.0 两次发版都忘了改（发版脚本 tools/bump-version.mjs 也没有覆盖这个文件），
# 于是按本文件构建出来的容器里装的仍是旧版本 —— Glama 请求构建 6.5.0、拿到的却是旧版本，
# 版本不符 → 构建判定失败（Glama 恰好从 6.4.0 起开始报 build failed）。
#
# 现在默认**从仓库的 package.json 读取版本**，人工同步这一环被彻底去掉；
# ARG 只作为**可选覆盖**保留（若下游想钉某个具体版本，传 --build-arg 即可）。
# 另：tools/check-release.mjs 会断言本文件不含写死的旧版本号（**只看非注释行**），防止旧写法复活。

FROM node:22-slim

ARG DSH_NOVEL_WRITER_VERSION=

# 只 COPY 一个 package.json 即可取到版本号，不必拉整个仓库（构建缓存也更友好）
COPY package.json /tmp/pkgmeta/package.json
RUN PKG_VERSION=$(node -e "process.stdout.write(require('/tmp/pkgmeta/package.json').version)") \
 && VERSION="${DSH_NOVEL_WRITER_VERSION:-$PKG_VERSION}" \
 && echo "→ installing dsh-novel-writer@${VERSION}" \
 && npm install --global --no-fund --no-audit "dsh-novel-writer@${VERSION}"

# 放一本极小的示例书：目录检查若顺手调了 list/read 类工具，也能拿到真实数据。
RUN mkdir -p /novels/示例书 \
 && printf '# 第01章 示例\n\n这是一本用于自检的示例书。\n' > /novels/示例书/第01章.md

# 书库根目录优先级：--root > DSH_NOVEL_WRITER_ROOT > 当前工作目录。
ENV DSH_NOVEL_WRITER_ROOT=/novels
WORKDIR /novels

# stdio 传输：容器的 stdin/stdout 就是 MCP 通道。
ENTRYPOINT ["dsh-novel-writer-mcp"]
