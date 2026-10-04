# 客户端构建源

这些文本块由 `tools/build-client.mjs` 装配到 `lib/client.js` 的同名 V6 标记区。修改标记区内组件时先修改本目录，再执行 `npm run build`；`npm run build:check` 只校验源与产物一致，不写文件。标记区外的界面逻辑直接维护 `lib/client.js`。全部路径从脚本本身解析，不依赖当前目录或外部工作区。
