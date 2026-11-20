/**
 * dsh-novel-writer — 宿主端入口（v7.5.0）
 *
 * 仅保留插件协议导出（apply/inject/name）、工具可见性/审计/非净化流兜底与 22 个工具装配；
 * 各领域工具实现已拆分至 lib/tools/*.js，辅助与状态读写见 lib/core.js 与 lib/tools/shared.js。
 */

import { RAW_WRITING_PROMPT, BRIEF_TEXT, promptTextFor, CHAT_WRITING_PROMPT } from "./prompts.js";
import { hasRawModeMarker, streamWithRawRetry } from "./rawguard.js";
import { ALL_TOOLS, isToolVisibleSync, readSentenceStateSync, toolEnabled } from "./core.js";
// v6.6.0：本地事件日志（可观测性）。见 lib/log.js 文件头——**绝不把正文带出本机**、绝不抛错。
import { logEvent, summarizeArgs } from "./log.js";
import { registerNovelBooks, registerNovelChapters, registerNovelRead, registerNovelKeywords, registerNovelImport, registerNovelDeleteBook } from "./tools/library.js";
import { registerNovelNewChapter, registerNovelChapterBrief, registerNovelDraft, registerNovelOutline, registerNovelLexicon } from "./tools/writing.js";
import { registerNovelSentenceAnalysis, registerNovelStyleCheck, registerNovelStyleReport, registerNovelFixPlan } from "./tools/style.js";
import { registerNovelSettings, registerNovelSummary, registerNovelPlot, registerNovelSemanticSearch } from "./tools/story.js";
import { registerNovelContinuityCheck } from "./tools/continuity.js";
import { registerNovelSentenceConfig, registerNovelDiagnose, registerStyleConfigRoute, skillProvider } from "./tools/system.js";

const name = "novel-writer";
const inject = ["tools", "systemPrompt"];

const PLUGIN_TOOL_SET = new Set(ALL_TOOLS);
function createToolVisibilityWhen(toolName, callerWhen) {
  return function toolWhen(activationCtx) {
    try {
      if (!isToolVisibleSync(toolName)) return false;
    } catch {
      return true;
    }
    if (typeof callerWhen === "function") {
      try {
        return callerWhen(activationCtx);
      } catch {
        return true;
      }
    }
    return true;
  };
}
function attachToolVisibilityOptions(def, options) {
  if (def && typeof def.name === "string" && PLUGIN_TOOL_SET.has(def.name)) {
    return options && typeof options === "object"
      ? { ...options, when: createToolVisibilityWhen(def.name, options.when) }
      : { when: createToolVisibilityWhen(def.name) };
  }
  return options;
}

/**
 * v6.6.0：**工具调用审计**——在注册层包一层，20 个工具一处覆盖（不散落埋点）。
 *
 * 为什么包在注册层而不是每个工具体内：每个工具体内加埋点迟早会漏，而且**新加的工具必然忘**；
 * 而 `ctx.tools.register` 是唯一必经之路。这里临时替换它，把每个 def 的 `execute` 包一层，
 * 记录：工具名、**安全参数摘要**（`summarizeArgs`，只取书名/章号/action 等定位字段 +
 * content/text 的**长度**，绝不带内容）、耗时、结果状态（ok/degraded/failed）、降级条数、错误 code。
 *
 * 三条铁律：
 * ① **审计绝不能影响工具本身**——异常**原样抛出**（不吞、不转换、不改返回），
 *    包裹失败（宿主把 register 设成只读等）就直接放弃审计，不影响注册；
 * ② **绝不记正文**——参数只走 `summarizeArgs`，它按白名单取值；
 * ③ 注册完立刻还原 `register`，不留副作用。
 */
function installToolAudit(ctx) {
  const tools = ctx?.tools;
  if (!tools || typeof tools.register !== "function") return Object.assign(() => {}, { installed: false });
  const original = tools.register;
  const hadOwn = Object.prototype.hasOwnProperty.call(tools, "register");
  try {
    tools.register = function auditedRegister(def, options) {
      if (def && typeof def.execute === "function" && typeof def.name === "string") {
        const run = def.execute;
        const name = def.name;
        def = {
          ...def,
          execute: async function auditedExecute(args, exec) {
            const started = Date.now();
            let status = "ok";
            let degradedCount = 0;
            let code = "";
            let detail = "";
            try {
              const out = await run.call(this, args, exec);
              if (out && typeof out === "object") {
                if (Array.isArray(out.degraded)) degradedCount = out.degraded.length;
                if (degradedCount > 0) status = "degraded";
                // v7.3.1（#21）：审计说这条 `out.ok === false → failed` 分支当前不可达（属实：全仓没有工具
                // execute 返回 ok:false，ok:false 只出现在 HTTP 路由响应体里）。**但选择保留**：
                // 它只有两行、无副作用，而 log-test ⑨-c 的 probe_failed 就钉着它——删分支等于顺手削弱一个
                // 已有的失败信号、还要同时删测试用例。将来若有工具改成返回 {ok:false} 而不是抛错，这条会立刻有用。
                if (out.ok === false) {
                  status = "failed";
                  code = String(out.error ?? "").slice(0, 40);
                  detail = String(out.message ?? "");
                }
              }
              return out;
            } catch (e) {
              status = "failed";
              code = String(e?.code ?? "").slice(0, 40);
              detail = String(e?.message ?? e);
              throw e; // 铁律①：原样抛出
            } finally {
              // 只有"出了结果或有异常"才记（正常路径也记，用 status 区分）
              logEvent("tool_call", {
                tool: name, status, code, detail,
                ms: Date.now() - started, degradedCount,
                ...summarizeArgs(args)
              });
            }
          }
        };
      }
      const finalOptions = attachToolVisibilityOptions(def, options);
      return finalOptions !== void 0 ? original.call(this, def, finalOptions) : original.call(this, def);
    };
  } catch (e) {
    // 铁律①：宿主不允许覆盖就不审计，注册照常。
    // 但**必须留痕**（由实现子代理指出）：这是"整场会话的 tool_call 审计静默关闭"，
    // 日志里表现为"什么都没有"，而调用方会把"没有记录"读成"没有发生"——最需要记的一处。
    logEvent("internal", {
      tool: "installToolAudit", status: "failed", level: "warn",
      detail: "宿主不允许覆盖 tools.register，本次会话的工具调用审计已关闭（诊断报告将缺少调用统计）：" + String(e?.message ?? e)
    });
    return Object.assign(() => {}, { installed: false });
  }
  const restore = () => {
    try {
      if (hadOwn) tools.register = original;
      else delete tools.register;
    } catch { /* 还原失败也不影响功能 */ }
  };
  restore.installed = true;
  return restore;
}

/**
 * v6.9.0：非净化模式的**动笔兜底**（P1）。
 *
 * 为什么放在注册层而不是各工具里：这是对**模型流**的包装，与任何具体工具无关；
 * 三层闸门（开关 / 非净化模式标记 / 文字特征）见 lib/rawguard.js 文件头。
 * 宿主没有 `llm/stream`（非 cordis 或裁剪版）时安静跳过——那不是错误，只是没有兜底。
 */
function installRawModeGuard(ctx) {
  if (!ctx || typeof ctx.on !== "function") return;
  try {
    ctx.on("llm/stream", (options, next) => {
      let on = false;
      try { on = readSentenceStateSync()?.features?.rawWriting === true; } catch { on = false; }
      if (!on) return next();
      // 开关开着，但这次请求的系统提示里没有非净化模式标记 → 不是写作模式的请求，不接管
      if (!hasRawModeMarker(options)) return next();
      try {
        return streamWithRawRetry((opts) => next(opts), options, {
          // v7.3.1（#55 连带）：rawguard 现在会带上命中的**规则类别**（softStopRule 复算，与 explicit.js 同源规则表），
          // 失败回退原流时还带 fallback:"original" + error。日志里必须把它们写出来——
          // 否则"提升可观测性"这件事只存在于函数签名里，你查日志仍只看到 chars。
          onRetry: (info) => logEvent("raw", {
            action: "softening_retry",
            count: info.chars,
            level: "warn",
            detail: info.fallback === "original"
              ? "非净化模式兜底：命中了软化规则（" + (info.category ?? "未知") + (info.label ? "：" + info.label : "") + "），"
                + "但重试请求构造失败（" + String(info.error ?? "").slice(0, 60) + "），已回退原流、按原样透传"
              : "模型在非净化模式里淡化了场景（命中类别：" + (info.category ?? "未知") + (info.label ? "：" + info.label : "")
                + "）：已丢弃本次输出并重试一次（只重试一次；不记录任何正文）"
          })
        });
      } catch (e) {
        logEvent("internal", { level: "warn", detail: "非净化模式兜底包流失败（本次按原流透传）：" + String(e?.message ?? e).slice(0, 80) });
        return next();
      }
    });
  } catch (e) {
    // 装上失败 = 整条兜底链路静默缺失（开关看起来仍然"打开"），必须留痕
    logEvent("internal", { level: "warn", detail: "llm/stream 钩子安装失败（非净化模式没有自动重试，其余功能不受影响）：" + String(e?.message ?? e).slice(0, 120) });
  }
}

function apply(ctx, config = {}) {
  // v6.6.0：先装审计包装（20 个工具一处覆盖），注册完立刻还原
  const restoreAudit = installToolAudit(ctx);
  const regCtx = !restoreAudit.installed && ctx?.tools && typeof ctx.tools.register === "function"
    ? {
        ...ctx,
        tools: {
          ...ctx.tools,
          register(def, options) {
            const finalOptions = attachToolVisibilityOptions(def, options);
            return finalOptions !== void 0 ? ctx.tools.register(def, finalOptions) : ctx.tools.register(def);
          }
        }
      }
    : ctx;
  try {
    registerNovelBooks(regCtx, config);
    registerNovelChapters(regCtx, config);
    registerNovelRead(regCtx, config);
    registerNovelKeywords(regCtx, config);
    registerNovelNewChapter(regCtx, config);
    // v5.0.0：开写包（动笔前装配材料）——紧跟新建章节，因为它的典型调用时机就是"要写下一章了"
    registerNovelChapterBrief(regCtx, config);
    // v6.2.0：必用词表——开写包的下游配套（开写包注入词表硬清单，词表负责登记与成稿审计）
    registerNovelLexicon(regCtx, config);
    registerNovelImport(regCtx, config);
    registerNovelSentenceAnalysis(regCtx, config);
    registerNovelSentenceConfig(regCtx, config);
    registerNovelStyleCheck(regCtx, config);
    // v5.0.0：改稿台（诊断转待办 + 复测）——紧跟风格自检，二者是"判定"与"行动"的关系
    registerNovelFixPlan(regCtx, config);
    registerNovelPlot(regCtx, config);
    registerNovelSettings(regCtx, config);
    registerNovelStyleReport(regCtx, config);
    registerNovelSummary(regCtx, config);
    registerNovelContinuityCheck(regCtx, config);
    registerNovelSemanticSearch(regCtx, config);
    registerNovelOutline(regCtx, config);
    // v6.6.0：诊断（读事件日志 + 体检，把"看不出来的错"讲成人话）
    registerNovelDiagnose(regCtx, config);
    // v6.8.0：按书删除（正文 + 创作资料 + 全部关联资料，移入回收站可恢复）
    registerNovelDeleteBook(regCtx, config);
    // v7.3.0：实时聊天写作的草稿镜像（逐段只追加，正式章节在确认前不动）
    registerNovelDraft(regCtx, config);
  } finally {
    restoreAudit();
  }
  // 注册 UI 开关状态路由（可选注入，headless 自动跳过）
  registerStyleConfigRoute(ctx, config);
  // v6.9.0：非净化模式的动笔兜底（llm/stream 钩子；宿主无该服务时安静跳过）
  installRawModeGuard(ctx);
  // v4.3.0：把包内 novel-writing 技能注册给宿主（可选注入——宿主无 skills 服务时静默跳过，不影响其余功能）
  // v7.3.3 修（#10）：与 installRawModeGuard 同款 typeof 守卫。最小宿主（只注入 tools+systemPrompt）
  // 没有 ctx.inject，旧版裸调会抛 TypeError，导致整个 apply 中断——22 个工具已注册，但 3 条
  // systemPrompt.section 一条都没注册（提示词层整块缺失，且用户只看到"插件好像没生效"）。
  if (ctx && typeof ctx.inject === "function") {
    ctx.inject(["skills"], (sctx) => {
      // 服务缺失是合法的宿主配置（headless / 裁剪版），不是错误——照 webServer 的写法静默跳过
      if (!sctx || !sctx.skills || typeof sctx.skills.registerProvider !== "function") return;
      try {
        sctx.skills.registerProvider(() => skillProvider);
      } catch (error) {
        console.warn("[dsh-novel-writer] skill provider registration failed:", error instanceof Error ? error.message : String(error));
        // v6.6.0：console.warn 只到 stderr（GUI 用户永远看不到）——skills 提供者没注册＝技能目录整块缺失，
        // 而"工具仍然能用"会让这件事一直不被发现
        logEvent("internal", { level: "warn", detail: "skills 提供者注册失败（技能列表可能为空）：" + (error instanceof Error ? error.message : String(error)) });
      }
    });
  }
  // v4.0.0：系统提示词三档注入（关闭 / 精简 / 完整）——沿用 DSH 官方"动态 section"写法（参照 yexi-by/dsh-unrestricted、masknull/dsh-session-prompt）：
  // text 为函数，返回空串时 DSH 自动丢弃该段（dsh-system-prompt: filter(text.length > 0)），因此"关闭"档 = 完全不注入。
  // 档位存在 state 文件里，由侧边栏首页开关写入；组装提示词时实时读取，下一轮对话生效，无需重启。
  ctx.systemPrompt.section({
    name: "novel-writing",
    order: 150,
    text: () => {
      try {
        const st = readSentenceStateSync();
        // v5.0.0：档位（注入多少）× 场景（注入什么）。选择逻辑收进 prompts.js 的纯函数 promptTextFor——
        // 这里只负责读状态与兜底，便于单测覆盖"老状态文件（无 promptScene）行为不变"。
        // v5.0.0（降本）：leanWorkflow=true 时优先注入精简档（LEAN_TEXT），优先于场景——省 token 比"注入什么"更要紧
        const base = promptTextFor(st.systemPromptMode, st.promptScene, st.leanWorkflow === true);
        if (base === "") return "";
        if (ALL_TOOLS.some((name) => !toolEnabled(st, name))) {
          return base + "\n注意：部分 novel_* 工具已被关闭且不在当前可用工具列表中；未提供的工具不要调用，如需使用请提示用户用 novel_sentence_config 或侧栏面板开启。";
        }
        return base;
      } catch { /* 读不到开关时按精简档处理 */ }
      return BRIEF_TEXT;
    }
  });
  // v3.1.0 原创模式：不做动态 section（DSH 0.1.1-rc.2 对 section 返回 null 会导致对话失败——改为 novel_outline init 时把用户原创设定预填进 创作设定.md，经工具链注入）
  // v2.0.0 非净化模式：动态 section（text 为函数，组装提示词时实时读开关）
  ctx.systemPrompt.section({
    name: "novel-writing:raw-writing",
    order: 151,
    text: () => {
      try {
        const st = readSentenceStateSync();
        if (st.features?.rawWriting === true) return RAW_WRITING_PROMPT;
      } catch { /* 读不到开关则不注入 */ }
      return "";
    }
  });
  // v7.3.0 实时聊天写作：动态 section（与 rawWriting 同构——组装提示词时实时读开关，下一轮生效、无需重启）
  ctx.systemPrompt.section({
    name: "novel-writing:chat-writing",
    order: 152,
    text: () => {
      try {
        const st = readSentenceStateSync();
        if (st.features?.chatWriting === true) return CHAT_WRITING_PROMPT;
      } catch { /* 读不到开关则不注入 */ }
      return "";
    }
  });
}
export { apply, inject, name };
