    // ---- 与宿主端同步 ----
    var STATE_ROUTE = "/api/dsh-novel-writer/state";
    // v6.8.0：按书删除 / 回收站（宿主端与 novel_delete_book 同一实现，见 lib/bookdelete.js）
    var DELETE_ROUTE = "/api/dsh-novel-writer/delete-book";
    // v7.0.0：度量口径探测 + 旧口径缓存重建（GET 只读 / POST 删派生缓存）
    var CALIBER_ROUTE = "/api/dsh-novel-writer/metric-caliber";
    // v7.2.0：对抗性审计（GET 探测 / POST audit|brief|verify；全是本地计算，零 token，只读不落盘）
    var AUDIT_ROUTE = "/api/dsh-novel-writer/audit";
  // v7.3.0：草稿镜像的只读预览（面板唯一能"看到他在写什么"的入口）
  var DRAFT_ROUTE = "/api/dsh-novel-writer/draft";
  // v7.5.0：外置 JSON 题材规则包（GET 列包/查按书绑定；POST 绑定/解绑）
  var PACKS_ROUTE = "/api/dsh-novel-writer/packs";
    var STORAGE_KEY = "dsh.novelWriter.state.v1";
    // v7.3.3 修（#5/M4）：基线页「当前书」是纯 UI 偏好——它不进宿主 state.json 的字段白名单，
    // 也不在 STORAGE_KEY 那份降级快照里（那份只在宿主不可达时才读回），于是刷新后必然回到空书名，
    // 而空书名请求会被宿主直接 400。单独一个键持久化，不污染降级快照。
    var BASELINE_BOOK_KEY = "dsh.novelWriter.baselineBook.v1";
    function readLocalBaselineBook() {
      try {
        var value = localStorage.getItem(BASELINE_BOOK_KEY);
        return typeof value === "string" ? value : "";
      } catch { return ""; } // localStorage 不可用（隐私模式/非浏览器环境）时只是不恢复
    }
    function writeLocalBaselineBook(book) {
      try {
        if (typeof book === "string" && book !== "") localStorage.setItem(BASELINE_BOOK_KEY, book);
        else localStorage.removeItem(BASELINE_BOOK_KEY);
      } catch { /* ignore */ }
    }
    // v4.3.0：统一请求超时——宿主 GET /state 会递归遍历数据目录 + 统计全书章节字数，
    // 数据目录很大或宿主挂起时 fetch 永不 settle：面板永久 loading、开关全 disabled 且没有任何提示
    var FETCH_TIMEOUT_MS = 8000;
    // v4.3.0：超时信号（特性检测：AbortSignal.timeout → AbortController → 无信号可用时退化为不超时）
    function makeTimeoutSignal(ms) {
      var wait = typeof ms === "number" && ms > 0 ? ms : FETCH_TIMEOUT_MS;
      try {
        if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
          return AbortSignal.timeout(wait);
        }
      } catch { /* 环境不完整时继续降级 */ }
      try {
        if (typeof AbortController === "function") {
          var controller = new AbortController();
          // 定时器触发即中止；不主动清理（到期自清），避免请求体读取阶段失去超时保护
          setTimeout(function () { try { controller.abort(); } catch { /* ignore */ } }, wait);
          return controller.signal;
        }
      } catch { /* 无 AbortController 时退化 */ }
      return void 0;
    }
    // v4.3.0：带超时的 fetch（浏览器端 API；无信号可用时等同普通 fetch）
    function fetchWithTimeout(url, init, ms) {
      var options = Object.assign({}, init || {});
      var signal = makeTimeoutSignal(ms);
      if (signal !== void 0) options.signal = signal;
      return fetch(url, options);
    }
    // v4.3.0：非 2xx 也先解析宿主 JSON，取可操作错误（照 openDir 已修好的写法：
    // 宿主会返回 {error:"报告不存在"} / {error:"request body too large (limit 1MB)"} / forbidden: loopback-only）
    function hostError(response) {
      return response.json().catch(function () { return {}; }).then(function (d) {
        var detail = d && typeof d.error === "string" && d.error !== "" ? d.error : "HTTP " + response.status;
        return new Error(detail);
      });
    }
    // v4.3.0：区分"宿主给了可操作错误"（原样透传）与"根本没连上"（降级成宿主端不可达）
    function errorText(err) {
      if (err instanceof TypeError) return t("state.unreachable");
      var name = err && typeof err.name === "string" ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return t("state.unreachable");
      var msg = err && typeof err.message === "string" ? err.message.trim() : "";
      return msg === "" ? t("state.unreachable") : msg;
    }
    // v7.3.2 修（N3）：把"保存失败"的两种性质分开——判据与 errorText 的「不可达」分支同一套：
    //   ① 宿主不可达 / 路由不可用（网络层 TypeError、超时取消、无可操作文案、404/405 路由未注册、
    //      501~504 网关层没有宿主）→ 本地降级模式：用户填的值**就是**本地生效值，不回滚、照常写 localStorage；
    //   ② 宿主明确拒绝（400 校验 / 413 / forbidden 这类带可操作文案的错误）→ 写入真的没生效，界面必须回滚。
    // 老实现在 catch 里无条件回滚，导致 ① 下 chatThreshold 成为唯一改不动的字段（localStorage 存的是回滚后的值）。
    function hostUnreachable(err) {
      if (err instanceof TypeError) return true;
      var name = err && typeof err.name === "string" ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") return true;
      var msg = err && typeof err.message === "string" ? err.message.trim() : "";
      if (msg === "") return true;
      return /^HTTP (404|405|501|502|503|504)$/.test(msg);
    }
    async function fetchState() {
      var response = await fetchWithTimeout(STATE_ROUTE, { headers: { accept: "application/json" } });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }
    async function saveState(patch) {
      var response = await fetchWithTimeout(STATE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(patch)
      });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }
    // v6.8.0：删书路由（JSON POST）。破坏性动作一律走 POST——不能落在可以被预取/缓存/重放的 GET 上。
    async function deleteBookRoute(payload) {
      var response = await fetchWithTimeout(DELETE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload || {})
      });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }

    // v6.8.0：报告历史的读取与"单份删除"（删除走回收站，可恢复）
    async function fetchReports() {
      var response = await fetchWithTimeout("/api/dsh-novel-writer/reports", { headers: { accept: "application/json" } });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }
    async function forgetReport(file) {
      var response = await fetchWithTimeout("/api/dsh-novel-writer/reports", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: "forget", file: String(file || "") })
      });
      if (!response.ok) throw await hostError(response);
      return await response.json();
    }
