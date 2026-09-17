# 最小容器：dsh-novel-writer 的 stdio MCP 服务器。
#
# 用途：Glama（https://glama.ai/mcp/servers/siweina/dsh-novel-writer）等 MCP 目录
# 通过「构建容器 → 启动 → 用 JSON-RPC over stdio 读 tools/list」来做内省检查。
# 该检查只需要服务器能起来并回答 initialize + tools/list，
# 不需要书库数据、不需要联网、不需要任何 API Key。
#
# 说明：插件的本地 ONNX 语义引擎（onnxruntime-web）是纯 WASM 实现，
# 因此这里没有原生编译步骤，装完即可跑。

FROM node:22-slim

# 固定到当前已发布版本，保证内省结果可复现。
# 每次发版请与 package.json / server.json 一同更新此版本号。
ARG DSH_NOVEL_WRITER_VERSION=4.3.1

RUN npm install --global --no-fund --no-audit "dsh-novel-writer@${DSH_NOVEL_WRITER_VERSION}"

# 放一本极小的示例书：目录检查若顺手调了 list/read 类工具，也能拿到真实数据。
RUN mkdir -p /novels/示例书 \
 && printf '# 第01章 示例\n\n这是一本用于自检的示例书。\n' > /novels/示例书/第01章.md

# 书库根目录优先级：--root > DSH_NOVEL_WRITER_ROOT > 当前工作目录。
ENV DSH_NOVEL_WRITER_ROOT=/novels
WORKDIR /novels

# stdio 传输：容器的 stdin/stdout 就是 MCP 通道。
ENTRYPOINT ["dsh-novel-writer-mcp"]
