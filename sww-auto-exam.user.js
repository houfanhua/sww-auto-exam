// ==UserScript==
// @name         双卫网智能答题助手
// @name:en      SWW Smart Study Assistant
// @namespace    sww-auto-exam
// @version      4.7
// @description  双卫网(sww.com.cn)继续医学教育助手：① 答题模式——题目自动识别，按「本地题库 → 大模型 → 联网搜题」三级取答，答错自动换答案重答，答对的题自动入库；② 刷课模式——自动播放视频课时、自动处理 10 分钟「您是否在线」在线确认弹窗、播完自动进入下一课时，直到整门课学完。
// @description:en  Tampermonkey assistant for sww.com.cn continuing-education: auto-answer quizzes (local bank -> LLM -> web search, with retry until passed) and auto-watch video lessons (handles the periodic "are you online" dialog and advances to the next lesson).
// @author       houfanhua
// @license      MIT
// @homepageURL  https://github.com/houfanhua/sww-auto-exam
// @supportURL   https://github.com/houfanhua/sww-auto-exam/issues
// @updateURL    https://raw.githubusercontent.com/houfanhua/sww-auto-exam/main/sww-auto-exam.user.js
// @downloadURL  https://raw.githubusercontent.com/houfanhua/sww-auto-exam/main/sww-auto-exam.user.js
// @match        *://sww.com.cn/*
// @match        *://*.sww.com.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 0. 配置
   * ========================================================== */
  var LS_KEY = 'sww_auto_exam_v3';
  var CFG_KEY = 'sww_auto_exam_cfg_v3';

  var DEFAULTS = {
    strategy: 'auto',     // auto | bank | ai | search
    autoSubmit: false,    // 首次交卷是否自动（默认手动点「填答」）
    autoRetry: true,      // 答错后自动换答案重答（默认开启）
    maxRetry: 10,         // 单题最多尝试多少个候选
    maxRounds: 12,        // 最多自动重答轮数
    searchEngine: 'both', // all | so360 | sogou | bing | baidu | only；默认 all=全部引擎并行
    aiEndpoint: '',       // OpenAI 兼容接口（填了优先用大模型）
    aiKey: '',
    aiModel: '',
    playbackRate: 1,      // 视频倍速（1=原速；站点若会重置倍速则无效，属正常）
    lessonMaxMin: 45,     // 单课时最长停留分钟数（读不到视频时长时的兜底上限）
    skipEntered: true,    // ★ 脚本进过的课时不再进第二遍（防止学过的课反复重学浪费时间）
    restartIfNearEnd: true, // ★ 视频从结尾处续播时拉回开头重播（站点记忆播放位置，不重播可能不认学时）
    debug: false
  };

  // 存储层：优先油猴的 GM 存储（独立命名空间，不会被网站限制），
  // 其次 localStorage，最后退化为内存（隐私模式下 localStorage 也可能不可用）。
  var memStore = {};

  function storeGet(key) {
    try {
      if (typeof GM_getValue === 'function') {
        var v = GM_getValue(key, undefined);
        if (v !== undefined && v !== null) return v;
      }
    } catch (e) { /* ignore */ }
    try {
      var s = localStorage.getItem(key);
      if (s !== null) return JSON.parse(s);
    } catch (e) { /* ignore */ }
    return memStore[key];
  }
  function storeSet(key, value) {
    var ok = false;
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, value); ok = true; }
    } catch (e) { /* ignore */ }
    try {
      localStorage.setItem(key, JSON.stringify(value));
      ok = true;
    } catch (e) { /* ignore */ }
    if (!ok) memStore[key] = value;
  }

  function loadCfg() {
    var base = {};
    Object.keys(DEFAULTS).forEach(function (k) { base[k] = DEFAULTS[k]; });
    var raw = storeGet(CFG_KEY);
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) { if (k in base) base[k] = raw[k]; });
    }
    return base;
  }
  var cfg = loadCfg();

  function load() {
    var v = storeGet(LS_KEY);
    if (!v || typeof v !== 'object') return {};
    return v;
  }
  function save(s) { storeSet(LS_KEY, s); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ★ 自动巡航（视频学习模式）：跨页面持久的标志。不答题，只挂视频。
  //   存「巡航中的来源页 URL」，学完一节跳回课程详情页继续找下一个未学完课时，
  //   处理「您是否在线」弹窗、自动跳下一集，直到全部课时学完。
  //
  //   ⚠ v3 的致命 bug：cruiseBack() 写了但**从来没有被调用过**，
  //     所以「一节课刷完」之后脚本根本不知道要去下一节，
  //     只会等 driveVideoPage 里那个 6 分钟超时才跳回列表，而且不计入已学数。
  //   v4 的做法：真正探测「视频播完」→ finishLesson() 计数 + 推进（下一节 / 回列表）。
  function inIframeCtx() {
    try { return window.top !== window; } catch (e) { return true; }
  }
  // 当前课时页的唯一 key。iframe 里运行时用顶层页面 URL（跨域则退化为 referrer），
  // 保证顶层窗口和播放器 iframe 认定的「同一节课」是同一个 key，不会重复计数。
  function pageKey() {
    var u = location.href;
    if (inIframeCtx()) {
      try { u = window.top.location.href; } catch (e) { u = document.referrer || location.href; }
    }
    return String(u || '');
  }
  var lastPageKey = '';
  // 单页应用 / 站点用 hash 切换课时时页面不会重载，这里手动重置「本页」状态
  function resetPageIfChanged() {
    var k = pageKey();
    if (k === lastPageKey) return;
    lastPageKey = k;
    pageFinished = false;
    pageEnterAt = Date.now();
    lastProgress = -1;
    lastProgressAt = 0;
    forcePlayCount = 0;
    pageStartCur = -1;
    pageEntryCur = -1;
    pageMaxCur = 0;
    nearEndSince = 0;
    startedAtEndWarned = false;
    startedAtEndTries = 0;
    restartRetryAt = 0;
    seekChecked = false;
    warnedNoVideo = false;
    pageFinishedAt = 0;
    lastHeartbeatAt = 0;
  }
  function cruiseOn() {
    var st = load();
    return !!(st.__cruise && st.__cruiseFrom);
  }
  function cruiseStart(fromUrl) {
    var st = load();
    var from = fromUrl || location.href;
    // ★ 在视频播放页上点「自动巡航」：来源页绝不能是播放页自己（学完回列表时
    //   会回到本页 → 死循环）。一律用 project_id 推出真正的课程列表页。
    try {
      if (/study_id=/i.test(location.href)) {
        var pid0 = projectIdFromUrl(location.href);
        if (pid0) from = location.origin + '/html/projectDetail?project_id=' + pid0;
      } else if (isVideoPage() && document.referrer && /sww\.com\.cn/i.test(document.referrer)) {
        from = document.referrer;
      }
    } catch (e) { /* ignore */ }
    st.__cruise = true;
    st.__cruiseFrom = from;
    st.__cruiseCount = 0;          // 本次巡航已学完课时数
    st.__cruiseSeen = {};          // { 课时URL: 进入次数 }，防止同一节课死循环
    st.__cruiseSkip = {};          // 站点核对不通过的课时名单（本次巡航重新开始）
    st.__cruiseDoneKey = '';       // 最近一次判定学完的课时 key
    st.__cruisePending = null;     // 待回列表核对的课时（v4.2）
    st.__cruiseStartedAt = Date.now();
    save(st);
  }
  function cruiseStop() {
    var st = load();
    var done = st.__cruiseCount || 0;
    st.__cruise = false;
    st.__cruiseFrom = '';
    st.__cruiseDoneKey = '';
    st.__cruisePending = null;     // 用户停巡航 = 彻底停手，不留待核对记录
    save(st);
    return { done: done };
  }
  function seenMap() {
    var st = load();
    return st.__cruiseSeen || {};
  }
  // 站点核对不通过、被跳过的课时（避免同一节反复重进，但不影响其他课时继续学）
  function skipMap() {
    var st = load();
    return st.__cruiseSkip || {};
  }
  function markSeen(key) {
    var st = load();
    var m = st.__cruiseSeen || (st.__cruiseSeen = {});
    m[key] = (m[key] || 0) + 1;
    save(st);
    return m[key];
  }
  // 回课程列表（iframe 里就通知顶层页面去跳，自己跳会把列表加载进 iframe）
  function goBackToList(reason) {
    var st = load();
    var from = st.__cruiseFrom;
    // ★ 来源页若是某个播放页（含 study_id），一律换成它所属的课程列表页，
    //   否则「回列表」会回到播放页自己 → 学完永远停在播放页不进下一节
    if (from && /study_id=/i.test(from)) {
      var pid = projectIdFromUrl(from);
      if (pid) from = (String(from).match(/^https?:\/\/[^/]+/i) || [''])[0] +
        '/html/projectDetail?project_id=' + pid;
    }
    if (!from) {
      // 兜底：当前页带 project_id 就直接推列表页
      var pid2 = projectIdFromUrl(location.href);
      if (pid2) from = location.origin + '/html/projectDetail?project_id=' + pid2;
    }
    if (!from) return false;
    if (inIframeCtx()) {
      try { (window.top || window.parent).postMessage({ __swwLessonDone: true, reason: reason || '' }, '*'); } catch (e) { /* ignore */ }
      return true;
    }
    // ★ 已经站在列表页上了就别再 reload（否则会无限刷新）
    if (String(from) === pageKey()) {
      log('已在本页，直接找下一课时');
      setTimeout(handleProjectDetail, 800);
      return true;
    }
    log('↵ 返回课程列表继续找下一课时：' + from.slice(0, 90));
    var here = pageKey();
    location.href = from;
    // ★ 看门狗：8 秒后还停在同一页（跳转被吞）→ 用 replace 强推一次
    setTimeout(function () {
      try {
        if (pageKey() === here) {
          log('…跳转未生效 → 再次强推回列表');
          location.replace(from);
        }
      } catch (e) { /* ignore */ }
    }, 8000);
    return true;
  }
  function studyIdFromUrl(u) {
    var m = (u || '').match(/[?&]study_id=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function projectIdFromUrl(u) {
    var m = (u || '').match(/[?&]project_id=([^&#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function stateKey() {
    return studyIdFromUrl(location.href) || ('p_' + (projectIdFromUrl(location.href) || 'unknown'));
  }
  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function isVisible(n) {
    if (!n || !n.isConnected) return false;
    var st = window.getComputedStyle(n);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  /* ============================================================
   * 1. 日志面板
   * ========================================================== */
  var LOG_MAX = 400;
  var logPanel = null;
  // 把答案来源换算成置信度，方便你自己判断要不要交卷
  function confOf(tag, sc) {
    if (tag === '题库') return { star: 5, label: '题库' };
    if (tag === '大模型') return { star: 4, label: '大模型' };
    if (tag === '答案标记') return { star: 4, label: '搜到答案' };
    if (tag === '单项' || tag === '两项' || tag === '三项') {
      if (sc && sc >= 2) return { star: 3, label: '高得分' };
      if (sc && sc >= 1) return { star: 2, label: '低得分' };
      return { star: 1, label: '穷举猜测' };
    }
    return { star: 1, label: tag || '猜测' };
  }
  function starStr(n) {
    var s = ''; for (var i = 0; i < 5; i++) s += (i < n ? '★' : '☆'); return s;
  }

  function log(msg) {
    if (cfg.debug) console.log('[双卫答题]', msg);
    try {
      var p = logPanel || document.getElementById('sww-auto-log');
      if (!p) {
        p = document.createElement('div');
        p.id = 'sww-auto-log';
        p.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483646;max-width:400px;max-height:300px;overflow-y:auto;background:rgba(15,20,30,.94);color:#7CFC9A;font:12px/1.6 Consolas,monospace;padding:8px 10px;border-radius:8px;border:1px solid #3a4a5a;white-space:pre-wrap;word-break:break-word;box-shadow:0 6px 20px rgba(0,0,0,.45);';
        (document.body || document.documentElement).appendChild(p);
        logPanel = p;
      }
      var lines = p.dataset.lines ? p.dataset.lines.split('\n') : [];
      lines.push(new Date().toTimeString().substring(0, 8) + ' ' + msg);
      if (lines.length > LOG_MAX) lines = lines.slice(-LOG_MAX);
      p.dataset.lines = lines.join('\n');
      p.textContent = p.dataset.lines;
      p.scrollTop = p.scrollHeight;
    } catch (e) { /* ignore */ }
  }
  function notify(t, b) { try { GM_notification({ title: t, text: b, timeout: 6000 }); } catch (e) { log('★ ' + t + '：' + b); } }

  /* ============================================================
   * 2. 弹窗拦截（本次最关键的修复）
   *
   * 站点交卷后用**原生 confirm** 提示：
   *   “考试未通过！第1、2、3、4、5、题答题错误，是否重新答题？”
   * 原生弹窗是阻塞的：不点「确定」页面就卡死，脚本自然不会继续答题。
   * 旧脚本虽然覆盖了 confirm，却又调用了原始 confirm，弹窗照样弹出。
   * 这里改为：**只读取消息，绝不调用原始 confirm**，直接返回 true
   * （等同于用户点「确定」→ 站点进入重新答题流程），页面不会被阻塞。
   * ========================================================== */
  var dialogHandler = null;
  var nativeHooked = false;

  function installNativeDialogHook(onChange) {
    if (nativeHooked) return;
    nativeHooked = true;
    try {
      window.confirm = function (m) {
        var msg = String(m === undefined || m === null ? '' : m);
        try { onChange(msg, 'confirm'); } catch (e) { /* ignore */ }
        return true;                 // 关键：不调用原始 confirm，页面不阻塞
      };
      window.alert = function (m) {
        var msg = String(m === undefined || m === null ? '' : m);
        try { onChange(msg, 'alert'); } catch (e) { /* ignore */ }
        return true;
      };
    } catch (e) { /* ignore */ }
  }

  // 站点自绘弹窗（#dialog-win / #tip-win / .dati-dialog）也一并监听
  var DIALOG_SEL = '#dialog-win, #tip-win, .dati-dialog, .sy-alert';
  var lastDialogText = '';
  var dialogObserver = null;

  function readDialogText() {
    var texts = [];
    var nodes = document.querySelectorAll(DIALOG_SEL);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!isVisible(n)) continue;
      var msg = n.querySelector('.balance,.loginSucc-msg,.dialog-msg,.msg,.message,.content,.tips');
      var t;
      if (msg) {
        t = textOf(msg);
      } else {
        var clone = n.cloneNode(true);
        clone.querySelectorAll('button,a,input,.dialog-close,.close').forEach(function (x) { x.remove(); });
        t = textOf(clone);
      }
      if (t) texts.push(t);
    }
    return texts.join(' | ');
  }

  function installDialogWatcher(onChange) {
    if (dialogObserver) return;
    var tick = function () {
      var t = readDialogText();
      if (!t) { lastDialogText = ''; return; }
      if (t === lastDialogText) return;
      lastDialogText = t;
      try { onChange(t, 'dom'); } catch (e) { log('弹窗处理异常：' + (e && e.message)); }
    };
    dialogObserver = new MutationObserver(tick);
    var start = function () {
      if (!document.body) return setTimeout(start, 300);
      dialogObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      setInterval(tick, 400);
      tick();
    };
    start();
  }

  // 点掉自绘弹窗上的「确定」，避免遮罩挡住页面
  function confirmDomDialog() {
    var nodes = document.querySelectorAll('#dialog-win,.dati-dialog,.sy-alert');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!isVisible(n)) continue;
      var btn = Array.prototype.find.call(n.querySelectorAll('button,a,input[type="button"],input[type="submit"],.dati-btn,span'), function (el) {
        var t = (el.innerText || el.value || '').trim();
        return t === '确定' || t === '继续' || t === '重新答题' || t === '是的';
      });
      if (btn) { btn.click(); return true; }
    }
    return false;
  }

  /* ============================================================
   * 3. 题目结构提取
   *
   * 站点答题页真实结构（依据 /resources/index/css/style.css 与实际页面）：
   *   .online-dati > ul > li
   *     div.online-dati-title   题干（灰底蓝字，形如 "1、xxx"）
   *     ... input[type=checkbox] 选项（A、xxx / B、xxx ...）
   *   注意：站点单选题也用 checkbox 渲染，
   *   所以不能靠 input[type] 判断单选/多选 —— 一律先按单选尝试，错了再逐级加选项。
   * ========================================================== */
  var TITLE_SEL = '.online-dati-title,.dati-wenti-con,.dati-wenti,.question-title,.questionTitle,.q-title,.stem,.subject';

  function prefixLetter(t) {
    var m = String(t || '').match(/^\s*([A-Ha-h])\s*[、.．)）:：]/);
    if (m) return m[1].toUpperCase();
    var m2 = String(t || '').match(/^\s*[（(]\s*([A-Ha-h])\s*[)）]/);
    if (m2) return m2[1].toUpperCase();
    return '';
  }
  function cleanOptionText(t) {
    return String(t || '')
      .replace(/^\s*(?:[A-Ha-h])\s*[、.．)）:：]\s*/, '')
      .replace(/^\s*[（(]\s*[A-Ha-h]\s*[)）]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 文档顺序比较：a 是否在 b 之前
  function before(a, b) {
    if (!a || !b || a === b) return false;
    try { return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); } catch (e) { return false; }
  }

  // 把选项按 name 分组（同一题 = 同一 name）
  function collectOptionGroups() {
    var map = {};
    var inputs = document.querySelectorAll('input[type="radio"],input[type="checkbox"]');
    var uid = 0;
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (inp.disabled) continue;
      var nm = inp.name || ('__sww_g' + (uid++));
      if (!map[nm]) map[nm] = [];
      map[nm].push(inp);
    }
    var list = [];
    Object.keys(map).forEach(function (nm) {
      var g = map[nm];
      if (g.length < 2) return;
      list.push({ name: nm, inputs: g, first: g[0] });
    });
    // 按文档顺序排列
    list.sort(function (a, b) { return before(a.first, b.first) ? -1 : (before(b.first, a.first) ? 1 : 0); });
    return list;
  }

  function buildOptionEntries(group) {
    var opts = [], seen = {};
    group.inputs.forEach(function (r) {
      var label = r.closest('label');
      var raw = textOf(label);
      if (!raw) {
        var wrap = r.closest('li,.dati-item,.online-dati-item,div');
        raw = textOf(wrap);
      }
      if (!raw) return;
      var clean = cleanOptionText(raw);
      if (!clean || seen[clean]) return;
      seen[clean] = true;
      opts.push({ text: clean, raw: raw, input: r, letter: '', checked: !!r.checked });
    });
    if (!opts.length) return null;
    var usedLetter = {};
    opts.forEach(function (o) {
      var pl = prefixLetter(o.raw);
      if (pl && !usedLetter[pl]) { o.letter = pl; usedLetter[pl] = true; }
    });
    var next = 0;
    opts.forEach(function (o) {
      if (!o.letter) {
        while (usedLetter[String.fromCharCode(65 + next)]) next++;
        o.letter = String.fromCharCode(65 + next);
        usedLetter[o.letter] = true;
      }
    });
    return opts;
  }

  // 以题干为锚点，向后找到属于它的选项组
  function extractQuestions() {
    var titles = Array.prototype.slice.call(document.querySelectorAll(TITLE_SEL)).filter(function (t) {
      if (!isVisible(t)) return false;
      var s = textOf(t);
      return s.length > 1;
    });
    if (!titles.length) return [];

    var groups = collectOptionGroups();
    if (!groups.length) return [];

    var qs = [];
    for (var i = 0; i < titles.length; i++) {
      var title = titles[i];
      var next = titles[i + 1];
      var best = null;
      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        if (!before(title, grp.first)) continue;         // 选项组必须在题干之后
        if (next && !before(grp.first, next)) continue;  // 且在下一题干之前
        if (!best) { best = grp; continue; }
        if (before(grp.first, best.first)) best = grp;    // 取最近的
      }
      if (!best) continue;

      var opts = buildOptionEntries(best);
      if (!opts || opts.length < 2) continue;

      var stem = textOf(title);
      // 题干里的题号 "1、" 单独取出来
      var numMatch = stem.match(/^\s*(\d{1,3})\s*[、.．)）]/);
      var num = numMatch ? parseInt(numMatch[1], 10) : (qs.length + 1);
      stem = stem.replace(/^\s*\d{1,3}\s*[、.．)）]\s*/, '').trim();
      if (!stem) stem = '（未识别题干）';

      qs.push({
        index: qs.length,
        num: num,
        stem: stem,
        opts: opts,
        group: best,
        isMulti: /多选|多项选择|不定项|以下哪些|下列哪些/.test(stem)
      });
    }

    // 按题号排序；题号缺失的保持原序
    qs.sort(function (a, b) { return a.num - b.num; });
    qs.forEach(function (q, i) { q.index = i; });
    return qs;
  }

  // 读取某题当前实际勾选的选项字母（用于「记录答案」：用户手动勾对后入库）
  function checkedLetters(q) {
    var out = [];
    if (!q || !q.opts) return out;
    q.opts.forEach(function (o) {
      try {
        if (o.input && o.input.checked) out.push(o.letter);
      } catch (e) { /* ignore */ }
    });
    return out.sort();
  }

  /* ============================================================
   * 4. 本地题库（答对后自动入库，下次直接命中）
   * ========================================================== */
  function normText(s) {
    return String(s || '')
      .replace(/^\s*\d{1,3}\s*[、.．)）]\s*/, '')
      .replace(/[\s\u3000]/g, '')
      .replace(/[，。；：、？！,.;:?!"'“”‘’()（）\[\]【】·]/g, '')
      .toLowerCase();
  }
  function bank() { return load().__bank || {}; }
  function saveBank(b) { var s = load(); s.__bank = b; save(s); }
  function lookupBank(q) {
    var b = bank();
    var key = normText(q.stem);
    if (Object.prototype.hasOwnProperty.call(b, key)) return b[key];
    var best = null, bestLen = 0;
    Object.keys(b).forEach(function (k) {
      if (!k || k.length < 4) return;
      if (key.indexOf(k) >= 0 || k.indexOf(key) >= 0) {
        if (k.length > bestLen) { best = b[k]; bestLen = k.length; }
      }
    });
    return best;
  }
  function recordBank(q, letters) {
    var b = bank();
    b[normText(q.stem)] = letters.slice();
    var keys = Object.keys(b);
    if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach(function (k) { delete b[k]; });
    saveBank(b);
  }
  function comboKey(letters) { return letters.slice().sort().join(''); }

  // 判断题选项归一化：把「正确/对/√/T/Y/是」和「错误/错/×/F/N/否」统一，
  // 这样题库里写「正确」、页面上写「对」也能对上（借鉴 FCQ 的做法）。
  function normJudgeText(s) {
    var t = String(s || '').replace(/[\s\u3000]/g, '').toLowerCase();
    if (t === '正确' || t === '对' || t === '√' || t === '✓' || t === 't' || t === 'y' || t === 'true' || t === '是') return '对';
    if (t === '错误' || t === '错' || t === '×' || t === '✗' || t === 'f' || t === 'n' || t === 'false' || t === '否') return '错';
    return t;
  }

  // 判断某段答案文字（可能含“答案：”、“正确”等前缀）里真正的答案文字是什么。
  // 例如「正确答案：低盐饮食」「答案 对」「选 C 和 D」→ 尽力剥离提示词。
  function answerTextCandidates(s) {
    var raw = String(s || '');
    var out = [];
    // 先按行拆（多选题答案常是多行，每行一个正确选项）——FCQ 的核心做法
    var lines = raw.split(/\r?\n|;|；/).map(function (x) { return x.trim(); }).filter(Boolean);
    lines.forEach(function (ln) {
      ln = ln.replace(/^(?:正确答案|正确选项|答案|答|应选|故选|选项|参考答案|标准答案)\s*(?:是|为|选项)?\s*[:：是]?\s*/i, '');
      ln = ln.replace(/^(?:选|选择|填)\s*/i, '');
      ln = ln.replace(/[。.！!?？\s]+$/g, '');
      if (ln) out.push(ln);
    });
    if (!out.length) {
      var m = raw.match(/(?:正确答案|正确选项|答案|参考答案|标准答案)\s*(?:是|为)?\s*[:：是]?\s*([^\n。；;]{1,60})/i);
      if (m && m[1].trim()) out.push(m[1].trim().replace(/[。.！!?？\s]+$/g, ''));
    }
    return out;
  }

  function answerToLetters(q, answer) {
    var s = String(answer || '').trim();

    // ① 文字答案优先：按行拆，每行和选项文字做归一化比对（借鉴 FCQ）。
    //    必须放在字母匹配之前！
    //    因为“正确答案：维生素C具有较强的还原性”里的“C”是维生素C的C，
    //    不是选项字母；若先按字母抓会误判成选项 C。
    //    文字匹配只有在能对上本题某个选项文字时才成立，
    //    真正的字母型答案（如“答案：A”）对不上任何选项文字，会自然落到第 ② 步。
    var candidates = answerTextCandidates(s);
    if (candidates.length) {
      var matched = [];
      var judgeMode = q.opts.length === 2 &&
        q.opts.every(function (o) {
          var t = normText(o.text);
          return /^(对|错|正确|错误|是|否)$/.test(t) || /^(对|错|正确|错误|是|否)$/.test(normJudgeText(o.text));
        });
      candidates.forEach(function (cand) {
        var found = q.opts.filter(function (o) {
          if (judgeMode) {
            var a = normJudgeText(cand), b = normJudgeText(o.text);
            if (a === b) return true;
            // 题库写“正确”，页面写“对”；题库写“错误”，页面写“错”
            if (/^(对|正确|是|√)$/.test(a) && /^(对|正确|是|√)$/.test(b)) return true;
            if (/^(错|错误|否|×)$/.test(a) && /^(错|错误|否|×)$/.test(b)) return true;
          }
          var a = normText(cand), b = normText(o.text);
          if (!a || !b) return false;
          return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
        });
        found.forEach(function (o) {
          if (matched.indexOf(o.letter) < 0) matched.push(o.letter);
        });
      });
      if (matched.length) return matched;
    }

    // ② 字母型答案（文字匹配失败才走这里）："答案：A" / "正确答案：AC"
    //    但要校验字母确实对应本题的选项，避免把别的题的答案安到本题。
    //    纯字母串（题库直接存 ['A'] 或 "A,C"）无需关键词门槛；
    //    混合中文时才要求有答案提示词，防止"维生素C"里的 C 被误认成选项。
    var mu = s.match(/[A-Ha-h]/g);
    if (mu) {
      var letterOnly = mu.map(function (c) { return c.toUpperCase(); })
        .filter(function (L) { return q.opts.some(function (o) { return o.letter === L; }); });
      var pureLetters = /^[A-Ha-h][\s,，、/、;；|]*[A-Ha-h\s,，、/;；|]*$/.test(s.trim());
      var hasKeyword = /(答案|正确|选|应选|故选|答|选择|正确选项|参考答案|标准答案)/.test(s);
      if (letterOnly.length && (pureLetters || hasKeyword)) {
        var seen = {};
        return letterOnly.filter(function (L) { if (seen[L]) return false; seen[L] = 1; return true; });
      }
    }

    // ③ 整串兜底匹配
    var out = [];
    q.opts.forEach(function (o) {
      if (s && (o.text.indexOf(s) >= 0 || s.indexOf(o.text) >= 0)) {
        if (out.indexOf(o.letter) < 0) out.push(o.letter);
      }
    });
    return out;
  }

  /* ============================================================
   * 5. 联网搜题
   * ========================================================== */
  function stripHtml(html) {
    try {
      var d = document.createElement('div');
      d.innerHTML = html;
      d.querySelectorAll('script,style,nav,header,footer,aside,form,svg,noscript').forEach(function (s) { s.remove(); });
      return (d.innerText || d.textContent || '').replace(/\s+/g, ' ');
    } catch (e) { return String(html || '').replace(/\s+/g, ' '); }
  }
  function gmGet(url) {
    return new Promise(function (res) {
      var done = false;
      function finish(html) { if (done) return; done = true; res(stripHtml(String(html || '')).substring(0, 40000)); }
      var opts = {
        method: 'GET', timeout: 15000, url: url,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
        onload: function (r) { finish(r.responseText); },
        onerror: function () { finish(''); },
        ontimeout: function () { finish(''); }
      };
      // 优先用油猴的 GM_xmlhttpRequest（能绕过跨域/防盗链）；
      // 若没装油猴（普通扩展/直接运行）就用 fetch 兜底。
      if (typeof GM_xmlhttpRequest === 'function') {
        try { GM_xmlhttpRequest(opts); return; } catch (e) { /* 落到 fetch */ }
      }
      if (typeof fetch === 'function') {
        fetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit' })
          .then(function (r) { return r.text(); })
          .then(function (t) { finish(t); })
          .catch(function () { finish(''); });
      } else {
        finish('');
      }
    });
  }
  // 多引擎并行搜题：360(so.com) 对医学继续教育题最有效（能搜到华图/百度知道等题库），
  // 搜狗次之，Bing 最弱但保底。百度常被验证码拦截，失败即跳过，不拖慢。
  var SEARCH_SOURCES = [
    { name: 'so360', url: function (q) { return 'https://www.so.com/s?q=' + encodeURIComponent(q); } },
    { name: 'sogou', url: function (q) { return 'https://www.sogou.com/web?query=' + encodeURIComponent(q); } },
    { name: 'bing', url: function (q) { return 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&count=20'; } },
    { name: 'baidu', url: function (q) { return 'https://www.baidu.com/s?wd=' + encodeURIComponent(q); } }
  ];

  async function searchText(q) {
    var parts = [];
    for (var i = 0; i < SEARCH_SOURCES.length; i++) {
      var s = SEARCH_SOURCES[i];
      if (cfg.searchEngine === s.name) { parts.push(await gmGet(s.url(q))); continue; }
      if (cfg.searchEngine === 'only') continue;
      // 并发请求，谁先返回谁先算；失败源（验证码/网络）返回空，不影响其它源。
      parts.push(await gmGet(s.url(q)));
      await sleep(60);
    }
    return parts.join(' \n ');
  }

  function countOccur(hay, nd) {
    if (!nd || nd.length < 2 || !hay) return 0;
    var c = 0, i = 0;
    while ((i = hay.indexOf(nd, i)) !== -1) { c++; i += nd.length; }
    return c;
  }
  function gramsOf(text) {
    var grams = [];
    var re = /[\u4e00-\u9fa5]+|[a-zA-Z0-9]+/g, m;
    while ((m = re.exec(text))) {
      var seg = m[0];
      if (/[\u4e00-\u9fa5]/.test(seg)) {
        for (var i = 0; i + 2 <= seg.length; i++) grams.push(seg.substr(i, 2));
      } else if (seg.length >= 3) {
        grams.push(seg.toLowerCase());
      }
    }
    return grams;
  }

  /* ---- 5.1 答案标记：搜题结果里通常直接写“正确答案：A” ---- */
  var MARKER_RES = [
    { re: /正确答案\s*(?:是|为|选项)?\s*[:：]?\s*([A-H](?:\s*[,，、和及与\/]\s*[A-H])*)/gi, w: 100 },
    { re: /正确选项\s*(?:是|为)?\s*[:：]?\s*([A-H](?:\s*[,，、和及与\/]\s*[A-H])*)/g, w: 95 },
    { re: /答案\s*(?:是|为|选项)?\s*[:：]\s*([A-H](?:\s*[,，、和及与\/]\s*[A-H])*)/gi, w: 90 },
    { re: /故选\s*[:：]?\s*([A-H](?:\s*[,，、和及与\/]\s*[A-H])*)/g, w: 80 },
    { re: /应选\s*[:：]?\s*([A-H](?:\s*[,，、和及与\/]\s*[A-H])*)/g, w: 80 },
    { re: /【\s*([A-H])\s*】/g, w: 55 }
  ];
  var NEG_CUE = /(不包括|不包含|不属于|不是|不正确|不正确的是|错误的?是|除外|错误的是|不属于的是)/;
  var NEG_WINDOW = 60;

  function extractMarkerInstances(txt) {
    var inst = [];
    if (!txt) return inst;
    MARKER_RES.forEach(function (r) {
      r.re.lastIndex = 0;
      var m;
      while ((m = r.re.exec(txt)) !== null) {
        if (!m[0].length) { r.re.lastIndex++; continue; }
        var letters = m[1].toUpperCase().split(/[^A-H]+/).filter(Boolean);
        if (!letters.length) continue;
        inst.push({
          letters: letters,
          ctx: txt.slice(Math.max(0, m.index - 150), Math.min(txt.length, m.index + m[0].length + 150))
        });
      }
    });
    return inst;
  }

  function proximityScore(optText, txt, negative) {
    if (!optText || optText.length < 2 || !txt) return 0;
    var best = 0, guard = 0;
    var idx = txt.indexOf(optText);
    while (idx >= 0 && guard < 20) {
      guard++;
      var win = txt.slice(Math.max(0, idx - NEG_WINDOW), Math.min(txt.length, idx + optText.length + NEG_WINDOW));
      if (/正确答案|答案|故选|应选|因此|所以/.test(win)) best += 3;
      if (NEG_CUE.test(win)) best += negative ? 6 : -5;
      idx = txt.indexOf(optText, idx + optText.length);
    }
    return best;
  }
  function scoreOption(opt, txt, negative) {
    var whole = normText(opt);
    if (!whole || !txt) return 0;
    var s = 0;
    if (whole.length >= 2) s += countOccur(txt, whole) * 4;
    var grams = gramsOf(opt);
    var hit = 0;
    grams.forEach(function (g) { if (countOccur(txt, g) > 0) hit++; });
    if (grams.length) s += (hit / grams.length) * 6;
    s += proximityScore(opt, txt, negative);
    return s;
  }

  // 用选项文本校验标记，避免把别的题的答案安到本题
  function markerCandidates(q, inst) {
    var merged = {};
    inst.forEach(function (it) {
      var letters = it.letters.filter(function (L) {
        return q.opts.some(function (o) { return o.letter === L; });
      });
      if (!letters.length) return;
      var valid = letters.filter(function (L) {
        var o = q.opts.filter(function (x) { return x.letter === L; })[0];
        if (!o) return false;
        var t = normText(o.text);
        if (t.length < 2) return true;
        return normText(it.ctx).indexOf(t.slice(0, Math.min(6, t.length))) >= 0;
      });
      if (!valid.length) valid = letters;
      var k = comboKey(valid);
      if (!merged[k]) merged[k] = { letters: valid, sc: 0 };
      merged[k].sc += 1;
    });
    return Object.keys(merged).map(function (k) { return merged[k]; })
      .sort(function (a, b) { return b.sc - a.sc; });
  }

  // 搜题结果里的文字型答案标记：把「正确答案：低盐饮食」这样的句子
  // 按行/按答案词拆开，再和本题选项文字做归一化比对，转成选项字母。
  // 借鉴 FCQ 的思路：不依赖 A/B/C 字母，靠文字内容匹配。
  // 多选答案常是多行（每行一个正确选项），这里会把多行合并成一个多选候选。
  function textMarkerCandidates(q, txt) {
    if (!txt) return [];
    // 只抓明确带“答案/正确/选”提示词的位置；用 [\s\S] 让正则能跨行吃到多行答案
    var re = /(?:正确答案|正确选项|参考答案|标准答案|答案|应选|故选|选择)\s*(?:是|为|选项)?\s*[:：是]?\s*([^\n。；;！!?？]{1,80})/gi;
    var merged = {};
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(txt)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }
      var cap = m[1];
      // 字母型答案已在 extractMarkerInstances 处理，这里跳过纯字母
      if (/^[A-Ha-h](?:\s*[,，、/]\s*[A-Ha-h])*\s*$/.test(cap.trim())) continue;
      var letters = answerToLetters(q, cap);
      // 多行答案：继续往后抓相邻的“选项文字”行，合并成多选
      var peek = txt.slice(m.index + m[0].length, m.index + m[0].length + 200);
      peek.split(/\r?\n/).slice(0, 4).forEach(function (ln) {
        ln = ln.trim();
        if (!ln || /^(答案|正确答案|解析|参考|故选|应选)/.test(ln)) return;
        if (/^[A-Ha-h](?:\s*[,，、/]\s*[A-Ha-h])*\s*$/.test(ln)) return;
        answerToLetters(q, ln).forEach(function (L) { if (letters.indexOf(L) < 0) letters.push(L); });
      });
      letters = letters.filter(function (L) { return q.opts.some(function (o) { return o.letter === L; }); });
      if (letters.length) {
        var k = comboKey(letters);
        if (!merged[k]) merged[k] = { letters: letters, sc: 0 };
        merged[k].sc += 1;
      }
    }
    return Object.keys(merged).map(function (k) { return merged[k]; })
      .sort(function (a, b) { return b.sc - a.sc; });
  }
  // 站点单选题也用 checkbox 渲染，无法从 DOM 判断单选/多选，
  // 所以不能只试单选（多选题选不全会一直错），
  // 也不能只试两项（单选会多选）。
  // 交错顺序 = 单(1)、双(1,2)、单(2)、双(1,3)、单(3)、双(2,3)、单(4)、双(1,4)…
  // 这样多选题最多第 2 轮就能命中，单选题最多第 3 轮也能命中。
  function buildLadder(q, scores, multiFirst) {
    var idxs = q.opts.map(function (_, i) { return i; });
    idxs.sort(function (a, b) { return scores[b] - scores[a]; });

    var singles = idxs.map(function (i) {
      return { letters: [q.opts[i].letter], sc: scores[i], tag: '单项', size: 1 };
    });
    var pairs = [];
    for (var a = 0; a < idxs.length; a++) {
      for (var b = a + 1; b < idxs.length; b++) {
        pairs.push({
          letters: [q.opts[idxs[a]].letter, q.opts[idxs[b]].letter],
          sc: scores[idxs[a]] + scores[idxs[b]],
          tag: '两项',
          size: 2
        });
      }
    }
    var triples = [];
    for (var x = 0; x < idxs.length; x++) {
      for (var y = x + 1; y < idxs.length; y++) {
        for (var z = y + 1; z < idxs.length; z++) {
          triples.push({
            letters: [q.opts[idxs[x]].letter, q.opts[idxs[y]].letter, q.opts[idxs[z]].letter],
            sc: scores[idxs[x]] + scores[idxs[y]] + scores[idxs[z]],
            tag: '三项',
            size: 3
          });
        }
      }
    }

    if (multiFirst) {
      // 答案标记显示是多选 → 先两项、再三项、最后单项兜底
      return pairs.concat(triples, singles);
    }

    // 交错：单、双、单、双…
    var inter = [];
    var pi = 0;
    singles.forEach(function (s, i) {
      inter.push(s);
      // 与「排第二的单项」组成的组合先试
      if (i + 1 < singles.length) inter.push(pairs[pi++]);
      else if (pi < pairs.length) inter.push(pairs[pi++]);
    });
    return inter.concat(triples, pairs.slice(pi));
  }

  async function searchCandidates(q) {
    var stem = q.stem.replace(/\s+/g, ' ').trim();
    var negative = NEG_CUE.test(stem);
    var queries = [stem + ' 正确答案'];
    var kw = stem.replace(/[，。；：、？！,.;:?!"'“”‘’()（）]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 2; });
    if (kw.length) queries.push(kw.slice(0, 6).join(' ') + ' 答案');
    queries.push(stem.slice(0, 30) + ' 答案解析');

    var texts = [];
    for (var i = 0; i < queries.length; i++) {
      texts.push(await searchText(queries[i]));
      await sleep(180);
    }
    // 选与题干最相关的一条作为“主文本”，避免别的题的答案污染
    var stemGrams = gramsOf(stem);
    var bestIdx = 0, bestHit = -1;
    texts.forEach(function (t, i) {
      var hit = 0;
      stemGrams.forEach(function (g) { if (countOccur(t, g) > 0) hit++; });
      if (hit > bestHit) { bestHit = hit; bestIdx = i; }
    });
    var primary = texts[bestIdx] || '';
    var all = texts.join(' \n ');

    var mcands = markerCandidates(q, extractMarkerInstances(primary));

    // ★ 文字答案标记（借鉴 FCQ）：搜题结果常写「正确答案：低盐饮食」，
    //   而不是「答案：A」。extractMarkerInstances 只认字母，这里补一层文字解析。
    mcands = mcands.concat(textMarkerCandidates(q, primary));

    var scores = q.opts.map(function (o) { return scoreOption(o.text, all, negative); });

    // 否定题：出现在否定语境里的选项更可能是答案
    if (negative) {
      scores = scores.map(function (s, i) {
        var o = q.opts[i];
        if (!o || !o.text) return s;
        var cnt = 0, idx = all.indexOf(o.text), guard = 0;
        while (idx >= 0 && guard < 20) {
          guard++;
          var win = all.slice(Math.max(0, idx - 30), Math.min(all.length, idx + o.text.length + NEG_WINDOW));
          if (NEG_CUE.test(win)) cnt++;
          idx = all.indexOf(o.text, idx + o.text.length);
        }
        return s + cnt * 8;
      });
    }

    var cands = [];
    var multiFirst = false;
    mcands.forEach(function (c) {
      cands.push({ letters: c.letters, sc: 10000 + c.sc, tag: '答案标记' });
      if (c.letters.length > 1) multiFirst = true;   // 标记显示是多选
    });
    buildLadder(q, scores, multiFirst).forEach(function (c) {
      cands.push({ letters: c.letters, sc: c.sc, tag: c.tag });
    });

    return {
      cands: cands,
      hasMarker: mcands.length > 0,
      markerLetters: mcands.length ? mcands[0].letters : []
    };
  }

  /* ============================================================
   * 6. 可选：大模型接口（OpenAI 兼容）
   * ========================================================== */
  function aiCall(messages) {
    return new Promise(function (resolve, reject) {
      if (!cfg.aiEndpoint) return reject(new Error('未配置大模型接口'));
      var payload = JSON.stringify({ model: cfg.aiModel || undefined, temperature: 0, messages: messages });
      var hdr = { 'Content-Type': 'application/json' };
      if (cfg.aiKey) hdr['Authorization'] = 'Bearer ' + cfg.aiKey;
      var settled = false;
      function done(err, data) { if (settled) return; settled = true; err ? reject(err) : resolve(data); }
      // 优先油猴；没油猴就用 fetch 兜底
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'POST', url: cfg.aiEndpoint, headers: hdr, data: payload, timeout: 60000,
            onload: function (r) {
              if (r.status < 200 || r.status >= 300) return done(new Error('HTTP ' + r.status + ' ' + String(r.responseText || '').slice(0, 200)));
              try { done(null, JSON.parse(r.responseText)); } catch (e) { done(new Error('返回不是 JSON')); }
            },
            onerror: function () { done(new Error('请求失败')); },
            ontimeout: function () { done(new Error('请求超时')); }
          });
          return;
        } catch (e) { /* 落到 fetch */ }
      }
      if (typeof fetch === 'function') {
        fetch(cfg.aiEndpoint, { method: 'POST', headers: hdr, body: payload })
          .then(function (r) { return r.text(); })
          .then(function (t) {
            if (!t) return done(new Error('返回为空'));
            try { done(null, JSON.parse(t)); } catch (e) { done(new Error('返回不是 JSON')); }
          })
          .catch(function (e) { done(e || new Error('请求失败')); });
      } else {
        done(new Error('无 GM_xmlhttpRequest 也无 fetch，无法调用大模型'));
      }
    });
  }
  function parseLetters(t) {
    var s = String(t || '');
    var m = s.match(/答案\s*[:：]?\s*([A-H](?:\s*[,，、;；|]\s*[A-H])*)/i);
    if (m) return m[1].toUpperCase().split(/[^A-H]+/).filter(Boolean);
    var all = (s.toUpperCase().match(/\b[A-H]\b/g) || []);
    var out = [];
    all.forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); });
    return out;
  }
  async function aiCandidates(q) {
    var body = [
      '题目：' + q.stem,
      '选项：',
      q.opts.map(function (o) { return o.letter + '. ' + o.text; }).join('\n'),
      q.isMulti ? '这是多选题，请选出所有正确选项。' : '这是单选题（只有一个正确答案）。',
      '请只输出正确选项字母（多选用逗号分隔，例如 A,C），不要输出其它内容。'
    ].join('\n');
    var data = await aiCall([
      { role: 'system', content: '你是医学继续教育考试答题助手，只回答选项字母。' },
      { role: 'user', content: body }
    ]);
    var content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    var letters = parseLetters(content).filter(function (L) {
      return q.opts.some(function (o) { return o.letter === L; });
    });
    return letters;
  }

  /* ============================================================
   * 7. 候选答案生成
   * ========================================================== */
  async function buildCandidates(qs) {
    var cands = [];
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      var list = [];

      // ① 本地题库
      if (cfg.strategy === 'auto' || cfg.strategy === 'bank') {
        var b = lookupBank(q);
        if (b !== undefined && b !== null && b !== '') {
          var letters = answerToLetters(q, b);
          if (letters.length) {
            list.push({ letters: letters, sc: 50000, tag: '题库' });
            log('Q' + q.num + ' 命中题库 → ' + letters.join(','));
          }
        }
      }

      // ② 大模型
      if ((cfg.strategy === 'auto' && !list.length && cfg.aiEndpoint) || cfg.strategy === 'ai') {
        try {
          var ai = await aiCandidates(q);
          if (ai.length) {
            list.push({ letters: ai, sc: 40000, tag: '大模型' });
            log('Q' + q.num + ' 大模型 → ' + ai.join(','));
          }
        } catch (e) { log('Q' + q.num + ' 大模型失败：' + e.message); }
      }

      // ③ 联网搜题
      if ((cfg.strategy === 'auto' && !list.length) || cfg.strategy === 'search') {
        try {
          var sr = await searchCandidates(q);
          sr.cands.forEach(function (c) {
            var k = comboKey(c.letters);
            if (!list.some(function (x) { return comboKey(x.letters) === k; })) list.push(c);
          });
          log('Q' + q.num + ' ' + (sr.hasMarker ? '命中答案标记 ' + sr.markerLetters.join('') : '搜题') +
            ' → ' + sr.cands.slice(0, 5).map(function (c) { return c.letters.join('') + '(' + c.sc.toFixed(1) + ')'; }).join(' '));
        } catch (e) { log('Q' + q.num + ' 搜题失败：' + e.message); }
      }

      if (!list.length) {
        q.opts.forEach(function (o) { list.push({ letters: [o.letter], sc: 0, tag: '兜底' }); });
        log('Q' + q.num + ' 无可用候选，将逐个尝试');
      }
      cands.push(list.slice(0, Math.max(cfg.maxRetry, 2)));
      await sleep(120);
    }
    return cands;
  }

  /* ============================================================
   * 8. 勾选答案（兼容 Ion.CheckRadio 插件）
   * ========================================================== */
  function clearAll(qs) {
    qs.forEach(function (q) {
      q.opts.forEach(function (o) {
        var input = o.input;
        if (!input || !input.checked) return;
        try {
          input.checked = false;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) { /* ignore */ }
      });
    });
  }
  function selectOption(q, letter) {
    var o = null;
    for (var i = 0; i < q.opts.length; i++) if (q.opts[i].letter === letter) { o = q.opts[i]; break; }
    if (!o || !o.input) return false;
    var input = o.input;
    try {
      if (!input.checked) {
        input.click();                        // 触发 Ion.CheckRadio 的 change 处理
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (e) {
      try { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e2) { /* ignore */ }
    }
    try {
      var lab = input.closest('label') || input.parentElement;
      if (lab) {
        lab.style.outline = '2px solid #22c55e';
        lab.style.backgroundColor = 'rgba(34,197,94,.14)';
      }
    } catch (e) { /* ignore */ }
    return true;
  }

  /* ============================================================
   * 9. 交卷与结果判定
   * ========================================================== */
  function findSubmitButton() {
    var byId = document.getElementById('btn-submit');
    if (byId) return byId;
    var byClass = document.querySelector('.dati-btn,.dati-sub button,.dati-sub input,.online-dati-btn a');
    if (byClass) return byClass;
    var all = document.querySelectorAll('button,a,input[type="button"],input[type="submit"]');
    for (var i = 0; i < all.length; i++) {
      var t = (all[i].innerText || all[i].value || '').trim();
      if (t === '交卷' || t === '提交' || t === '提交答案') return all[i];
    }
    return null;
  }

  // 解析错题号。站点实际文案（见截图）：
  //   “考试未通过！第1、2、3、4、5、题答题错误，是否重新答题？”
  //   “考试未通过！第1题、第2题、第3题、题答题错误，是否重新答题？”
  // 两种写法都出现过，旧正则只能抓到第一个，后面全漏 → 错题没被换答案。
  // 做法：先定位“错误/答错”关键词，再把它**前面**的所有“第N题/第N”都收集起来。
  function extractWrongNums(t) {
    var kw = t.match(/答题错误|回答错误|答题不正确|存在错误|未答对|答错|错误/);
    if (!kw) return [];
    var head = t.slice(0, kw.index);
    var nums = [];
    var re = /第?\s*(\d{1,3})\s*题?/g;
    var m;
    while ((m = re.exec(head)) !== null) {
      var v = parseInt(m[1], 10);
      if (v > 0 && nums.indexOf(v) < 0) nums.push(v);
    }
    return nums;
  }

  function parseResult(text) {
    var t = String(text || '');
    var res = { passed: false, wrongNums: [], unknown: false, raw: t };
    if (!t) return res;

    if (/恭喜|全部答对|全部正确|答题正确|已通过|通过本?章节|考试通过|恭喜您|本章已通过|考核通过/.test(t)) {
      res.passed = true;
    }
    res.wrongNums = extractWrongNums(t);
    if (!res.wrongNums.length && !res.passed && /答题错误|回答错误|存在错误|未通过|答错|重新答题/.test(t)) {
      res.unknown = true;
    }
    return res;
  }

  /* ============================================================
   * 10. 主答题流程
   * ========================================================== */
  var running = false;
  var retryQueued = false;
  var lastPicks = null;    // [{num, letters}]

  async function runExam(opts) {
    opts = opts || {};
    if (running) { retryQueued = true; return; }
    running = true;
    try {
      var qs = extractQuestions();
      if (!qs.length) { log('未识别到题目（确认已进入答题页）'); return; }
      log('识别到 ' + qs.length + ' 题：' + qs.map(function (q) { return q.num + '.' + q.stem.slice(0, 16); }).join(' | '));

      var key = stateKey();
      var st = load();
      var rec = st[key] || (st[key] = {});
      if (rec.done) { log('本章节已标记通过，跳过'); return; }

      if (!rec.cands || rec.cands.length !== qs.length) {
        log('生成候选答案…');
        rec.cands = await buildCandidates(qs);
        rec.used = qs.map(function () { return 0; });
        rec.wrongCombos = {};
        save(st);
      }
      var cands = rec.cands;
      var used = rec.used || qs.map(function () { return 0; });
      var wrongCombos = rec.wrongCombos || (rec.wrongCombos = {});

      var picks = qs.map(function (q, i) {
        var seq = cands[i] || [];
        if (!seq.length) return { num: q.num, letters: [], tag: '无候选' };
        var u = (used[i] || 0) % seq.length;
        var ban = wrongCombos[q.num] || {};
        var chosen = null, guard = 0;
        while (guard < seq.length) {
          var c = seq[u % seq.length];
          if (!ban[comboKey(c.letters)]) { chosen = c; break; }
          u++; guard++;
        }
        if (!chosen) chosen = seq[(used[i] || 0) % seq.length];
        var letters = chosen.letters.slice();
        // 注意：站点单选也用 checkbox 渲染，不能靠 input[type] 区分单选/多选，
        // 答案组合的个数完全由候选阶梯决定（单项 → 两项 → 三项），
        // 所以这里**不再**强行截断成 1 个，否则多选题永远选不全。
        if (!letters.length) letters = [q.opts[0].letter];
        return { num: q.num, letters: letters, tag: chosen.tag };
      });

      lastPicks = picks;
      window.__swwLastPicks = picks;

      clearAll(qs);
      var applied = [];
      picks.forEach(function (p, i) {
        var q = qs[i];
        p.letters.forEach(function (L) { selectOption(q, L); });
        var cf = confOf(p.tag, p.sc);
        applied.push('Q' + q.num + '=' + p.letters.join(',') + '[' + cf.label + ' ' + starStr(cf.star) + ']');
      });
      log('已勾选：' + applied.join('  '));

      if (!opts.submit) {
        log('勾选完成（未交卷）。Alt+A 填答并交卷，Ctrl+Enter 交卷。');
        return;
      }

      var btn = findSubmitButton();
      if (!btn) { log('未找到交卷按钮'); return; }
      log('交卷…');
      btn.click();

      // 等待站点返回结果（由 handleResult 处理）。
      // 站点点「确定」后可能整页刷新，刷新后脚本会重新启动并自动继续。
      var waited = 0;
      while (waited < 25000) {
        await sleep(400);
        waited += 400;
        if (retryQueued) break;
        if (document.getElementById('sww-auto-log') !== logPanel) break;  // 页面已刷新
      }
      if (!retryQueued && document.getElementById('sww-auto-log') === logPanel) {
        log('等待结果超时（站点可能没有返回结果提示）');
      }
    } catch (e) {
      log('流程异常：' + (e && e.message ? e.message : e));
    } finally {
      running = false;
      if (retryQueued) {
        retryQueued = false;
        setTimeout(function () { runExam({ submit: true }); }, 400);
      }
    }
  }

  /* ============================================================
   * 11. 交卷结果处理：解析错题 → 换答案 → 自动继续答题
   * ========================================================== */
  var lastHandledText = '';
  var lastHandledAt = 0;
  var round = 0;

  async function handleResult(text, source) {
    if (!text) return;
    var now = Date.now();
    // 去重只针对「同一事件被重复上报」：
    //   - confirm：每次调用都是新的一轮结果，绝不能去重
    //   - dom：站点自绘弹窗，可能与 confirm 同一时刻上报同一段文字，
    //           此时 confirm 已处理过，800ms 内忽略 dom 的重复。
    // 关键：不能用「文字相同」长时间去重，
    // 否则每轮都错同样几题时，第二轮开始就被吞掉 → 不再继续答题。
    if (source === 'dom' && text === lastHandledText && (now - lastHandledAt) < 800) return;
    lastHandledText = text;
    lastHandledAt = now;
    if (!/答题|答对|答错|错误|通过|恭喜|重新答题|未通过|题/.test(text)) return;

    var res = parseResult(text);
    log('[' + (source || 'dom') + '] 站点提示：' + res.raw.slice(0, 200));

    if (res.passed) {
      var qs = extractQuestions();
      if (lastPicks && qs.length) {
        lastPicks.forEach(function (p, i) {
          var q = qs.filter(function (x) { return x.num === p.num; })[0] || qs[i];
          if (q) recordBank(q, p.letters);
        });
      }
      var st = load();
      var key = stateKey();
      st[key] = st[key] || {};
      st[key].done = true;
      save(st);
      notify('双卫答题通过', '本章节全部答对！答案已存入题库。');
      log('✓ 全部答对，本轮答案已存入题库');
      return;
    }

    confirmDomDialog();     // 关掉自绘弹窗

    if (!cfg.autoRetry) return;

    var qs2 = extractQuestions();
    if (!qs2.length) { log('未识别到题目，无法自动重答'); return; }

    var key2 = stateKey();
    var st2 = load();
    var rec2 = st2[key2] || (st2[key2] = {});
    var used = rec2.used || qs2.map(function () { return 0; });
    var wrongCombos = rec2.wrongCombos || (rec2.wrongCombos = {});
    var cands2 = rec2.cands || [];

    function banFor(num, letters) {
      var b = wrongCombos[num] || (wrongCombos[num] = {});
      b[comboKey(letters)] = true;
    }

    if (res.unknown) {
      log('未解析出错题号 → 全部题推进到下一候选');
      (lastPicks || []).forEach(function (p, i) {
        banFor(p.num, p.letters);
        used[i] = (used[i] || 0) + 1;
      });
    } else {
      log('错题号：' + res.wrongNums.join(','));
      res.wrongNums.forEach(function (n) {
        var idx = -1;
        for (var i = 0; i < qs2.length; i++) if (qs2[i].num === n) idx = i;
        if (idx < 0 && n >= 1 && n <= qs2.length) idx = n - 1;
        if (idx < 0) return;
        var q = qs2[idx];
        var p = (lastPicks || []).filter(function (x) { return x.num === q.num; })[0];
        if (p) banFor(q.num, p.letters);
        used[idx] = (used[idx] || 0) + 1;
      });
    }
    rec2.used = used;
    rec2.wrongCombos = wrongCombos;

    var exhausted = qs2.every(function (q, i) {
      var seq = cands2[i] || [];
      if (!seq.length) return true;
      var ban = wrongCombos[q.num] || {};
      return seq.every(function (c) { return ban[comboKey(c.letters)]; });
    });
    if (exhausted) {
      log('候选已用尽 → 重新搜题');
      delete rec2.cands;
      // 重搜之后候选重置，但已累计的失败轮次不能清零，否则永远重答。
    }

    // 轮次计数必须持久化：站点答错后常整页刷新，
    // 若 round 只在内存里，刷新就归零 → 永远达不到 maxRounds → 无限循环。
    round = (rec2.round || 0) + 1;
    rec2.round = round;
    save(st2);

    if (round > cfg.maxRounds) {
      log('已达最大重答轮数（' + round + ' 轮），停止自动重试。请手动检查或重置进度。');
      notify('双卫答题助手', '已达最大重答轮数（' + round + ' 轮），请手动检查。');
      return;
    }
    log('第 ' + round + ' 轮重答…');
    await sleep(400);
    await runExam({ submit: true });
  }

  /* ============================================================
   * 12. 课程列表页：进入未完成课时（视频学习巡航用）
   *     找「未学习/未完成/未观看/继续学习」的课时链接，跳进去挂视频。
   * ========================================================== */
  // 双卫网真实用词（2026-11-01 用户截图确认）：
  //   课程列表每行右侧两个入口：「视频（已学/学习中/未学）」和「答题（未答）」
  //   ★ 状态词就是「已学」「学习中」「未学」—— v3/v4 的完成词表里没有「已学」，
  //     导致已学的课被当成没学过、反复重学（v4.1 修复的根源）。
  //   项目级：「已申请学分」= 整个项目已完成
  var LESSON_DONE_CUE = /已申请学分|已完成|已学|已观看|学习完成|完成学习|100%|已通过|已结业|已取证|电子证/;
  var LESSON_TODO_CUE = /未学|学习中|继续学习|申请学分|未学完|未观看|未完成|未通过|去学习|开始学习|进入学习|开始答/;
  // 视频巡航只要视频链接，不要答题链接
  var LESSON_VIDEO_CUE = /视频|播放|观看|study|video|player|lesson|chapter/i;
  var LESSON_ANSWER_CUE = /答题|未答|答案|考试|exam|dati|test/i;

  // 从链接向上找「刚好包含状态词」的那一层容器的文字（太小没有状态、太大整张列表全混进来）
  function rowTextOf(a) {
    var el = a, plain = '';
    for (var i = 0; i < 5 && el && el !== document.body; i++) {
      el = el.parentElement;
      if (!el) break;
      var t = '';
      try { t = (el.innerText || '').replace(/\s+/g, ' ').trim(); } catch (e) { /* ignore */ }
      if (!t) continue;
      if (!plain) plain = t;
      if (t.length <= 160 && (LESSON_DONE_CUE.test(t) || LESSON_TODO_CUE.test(t))) return t;
    }
    return plain || (a.innerText || '');
  }

  // 这一行的视频是不是「已完成」：文字 + 完成图标样式 双保险
  function isRowDone(a, rowTxt) {
    if (LESSON_DONE_CUE.test(rowTxt)) return true;
    var m = String(rowTxt).match(/(\d{1,3})\s*%/);
    if (m && parseInt(m[1], 10) >= 100) return true;
    // 有的站点完成态只换图标/改 class，不改文字
    var cell = null;
    try { cell = a.closest('li,tr,dd,dt'); } catch (e) { /* ignore */ }
    if (cell) {
      var cn = String(cell.className || '');
      if (/\b(done|finish|complete|learned|studied|success)\b/i.test(cn)) return true;
      if (cell.querySelector && cell.querySelector('[class*="yiwancheng"],[class*="wancheng"],[class*="yixue"],[class*="icon-done"],[class*="icon-finish"],[class*="icon-complete"]')) return true;
    }
    return false;
  }

  // 扫描列表页上所有「视频」入口 → [{a,key,nav,text,row,done,pri}]（答题入口已被排除）
  function scanVideoLinks() {
    var links = document.querySelectorAll(
      'a[href*="study"],a[href*="lesson"],a[href*="chapter"],a[href*="catalog"],' +
      'a[href*="video"],a[href*="player"],a[href*="course"],a[href*="online"],' +
      'a[href*="study_id"],a[href*="project"],a[href*="apply"],' +
      'a[href*="play"],a[href*="vedio"],a[href*="media"],' +
      'li a,td a,.catalog a,.chapter a,.lesson a,.item a,tr a,dd a,dt a'
    );
    var out = [], usedKey = {};
    Array.prototype.forEach.call(links, function (a) {
      if (!a || !a.href) return;
      var linkTxt = (a.innerText || '').replace(/\s+/g, ' ').trim();
      var rowTxt = rowTextOf(a).replace(/\s+/g, ' ').trim();
      var txt = linkTxt || rowTxt;
      if (!txt) return;
      if (!LESSON_VIDEO_CUE.test(txt) && !/未学|学习中/.test(rowTxt)) return;
      if (LESSON_ANSWER_CUE.test(txt) && !LESSON_VIDEO_CUE.test(txt)) return;
      var nav, key;
      if (/^https?:/i.test(a.href) && !/^(javascript:|#)/i.test(String(a.getAttribute('href') || ''))) {
        var u = a.href;
        nav = function () { location.href = u; };
        key = String(u).split('#')[0].replace(/\/+$/, '');
      } else {
        var el = a;
        nav = function () { try { el.click(); } catch (e) { /* ignore */ } };
        key = 'txt:' + txt.slice(0, 40) + '|' + rowTxt.slice(0, 40);
      }
      if (usedKey[key]) return;
      usedKey[key] = 1;
      var done = isRowDone(a, rowTxt);
      var pri = done ? 9 : ((/未学/.test(txt + rowTxt)) ? 1 : ((/学习中/.test(txt + rowTxt)) ? 2 : 3));
      out.push({ a: a, key: key, nav: nav, text: txt, row: rowTxt, done: done, pri: pri });
    });
    return out;
  }

  // 按 key 找列表里的那一行（回列表核对「是否已学」用）
  function findLessonRow(key, title) {
    var all = scanVideoLinks(), i;
    for (i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    // key 对不上时用标题兜底模糊匹配（刷新后 URL 可能带随机参数）
    var t = String(title || '').slice(0, 12);
    if (t) for (i = 0; i < all.length; i++) if (all[i].row && all[i].row.indexOf(t) >= 0) return all[i];
    return null;
  }

  // 在课程列表页找下一个要学的「视频」入口
  function findUnfinishedLesson() {
    var cur = pageKey().replace(/\/+$/, '');
    var seen = seenMap();
    var skip = skipMap();
    var todo = [], enteredButUnmarked = 0, skippedCount = 0;
    scanVideoLinks().forEach(function (c) {
      if (c.done) return;                       // 「视频（已学）」→ 跳过
      if (c.key === cur) return;                // 就是当前页
      if (skip[c.key]) { skippedCount++; return; }   // 站点核对没通过、已跳过的课
      var cnt = seen[c.key] || 0;
      if (cnt >= 1 && cfg.skipEntered) { enteredButUnmarked++; return; }
      todo.push({ a: c.a, key: c.key, nav: c.nav, text: c.text, row: c.row, pri: c.pri, cnt: cnt });
    });
    lastScanAllEntered = (!todo.length && enteredButUnmarked > 0);
    lastScanSkipped = skippedCount;
    if (!todo.length) return null;
    todo.sort(function (x, y) { return (x.pri - y.pri) || (x.cnt - y.cnt); });
    return todo[0];
  }
  var lastScanSkipped = 0;

  var lastScanAllEntered = false;
  var listMissCount = 0;

  // ★ v4.2 核心：脚本不再自己给自己发毕业证。
  //   播放页只负责「挂一条 pending」，回到列表后**以站点的「已学」为准**核对：
  //     · 已学        → 才算真学完，计数 +1
  //     · 仍是未学/学习中 → 说明站点没记上，重进再学（最多 2 次），还不行就停下报错
  function verifyPendingOnList() {
    var st = load();
    var pend = st.__cruisePending;
    if (!pend || !pend.key) return false;
    if (!pend.finished) {            // 进去过但没判定播完 → 不算数，直接清掉
      st.__cruisePending = null;
      save(st);
      return false;
    }
    var row = findLessonRow(pend.key, pend.title);
    if (!row) {
      log('…回列表没找到上一节的入口，跳过核对：' + String(pend.title || '').slice(0, 30));
      st.__cruisePending = null;
      save(st);
      return false;
    }
    if (row.done) {
      st.__cruiseCount = (st.__cruiseCount || 0) + 1;
      st.__cruisePending = null;
      save(st);
      log('✓ 站点已记为「已学」：' + String(pend.title || '').slice(0, 30) +
        '（本次确认学完 ' + st.__cruiseCount + ' 节）');
      try { notify('课时已确认', '已确认学完 ' + st.__cruiseCount + ' 节'); } catch (e) { /* ignore */ }
      return false;                  // 继续找下一节
    }
    var tries = pend.tries || 0;
    // 每次核对都把站点原文打出来：这样「到底是不是站点没记上」一目了然
    log('[核对] 站点当前显示：' + String(row.row || '').replace(/\s+/g, ' ').slice(0, 90));
    if (tries < 1) {
      pend.tries = tries + 1;
      pend.finished = false;
      st.__cruisePending = pend;
      st.__cruiseDoneKey = '';       // 允许重新判定这一节
      save(st);
      log('⚠ 上一节『' + String(pend.title || '').slice(0, 26) + '』站点仍显示「' +
        (row.pri === 2 ? '学习中' : '未学') + '」→ 重进再学一次');
      row.nav();
      return true;                   // 已跳转，调用方别再动
    }
    // ★ v4.7：一节核对不过，不再把整门课停下来。
    //   把这节记入「站点未确认」名单后跳过，继续学后面的课时，收尾时统一汇报。
    st.__cruisePending = null;
    st.__cruiseSkip = st.__cruiseSkip || {};
    st.__cruiseSkip[pend.key] = 1;
    save(st);
    log('⚠ 这节站点没记成「已学」，先跳过它继续学别的：' + String(pend.title || '').slice(0, 30));
    log('   （等全部学完，用「识别课时」看这节的状态，必要时手动补一遍）');
    return false;                    // 继续往下找下一节
  }

  function handleProjectDetail() {
    if (!document.body) { setTimeout(handleProjectDetail, 800); return; }
    // ★ v4.6 护栏：播放页绝不做「课时扫描」，否则会把播放页当列表、乱跳甚至自己把自己当下一节
    if (/studyVideo/i.test(location.pathname) || /study_id=/i.test(location.search)) {
      log('…本页是播放页，不做课时扫描（交给视频巡航逻辑）');
      return;
    }
    // ① 先核对上一节在站点上到底有没有学成（以站点「已学」为准）
    if (cruiseOn() && verifyPendingOnList()) return;

    var t = findUnfinishedLesson();

    if (t) {
      listMissCount = 0;
      log((cruiseOn() ? '★ 视频巡航：' : '') + '进入课时 → ' +
        (t.row || t.text).slice(0, 44).replace(/\s+/g, ' '));
      markSeen(t.key);
      var st0 = load();
      st0.__cruiseDoneKey = '';        // 新课时，允许判定
      st0.__cruisePending = {          // 挂一条待核对记录（key 来自列表链接，回列表一定对得上）
        key: t.key, title: (t.row || t.text).slice(0, 60), at: Date.now(), tries: 0, finished: false
      };
      save(st0);
      t.nav();
      return;
    }

    // 没有更多可学的课时
    if (cruiseOn()) {
      // 「剩下的全是进过但未标已学」直接停，不用重试
      if (lastScanAllEntered) {
        var rr = cruiseStop();
        log('★ 巡航暂停（已处理 ' + rr.done + ' 节）：剩下的课时脚本都进过，但站点仍未标「已学」。');
        log('   两种可能：① 站点学习记录没回写（这些课需要重学）② 判定样式没对上。');
        log('   想强制重学：点「清已学记录」→ 再点「自动巡航」。');
        try { notify('双卫答题助手', '巡航暂停：剩余课时都进过但站点未标已学。可用「清已学记录」强制重学。'); } catch (e) { }
        return;
      }
      listMissCount++;
      if (listMissCount < 5) {
        log('…本页没识别到未学课时（第 ' + listMissCount + '/5 次），2.5 秒后重试（页面可能还在加载）');
        setTimeout(handleProjectDetail, 2500);
        return;
      }
      var r = cruiseStop();
      log('★ 视频巡航完成！本次共学完 ' + r.done + ' 节课时。');
      if (lastScanSkipped > 0) {
        log('   另有 ' + lastScanSkipped + ' 节站点未记成「已学」，已跳过（列表里仍是未学/学习中）。');
        log('   这 ' + lastScanSkipped + ' 节需要手动补：点「清已学记录」后重新巡航，或手动从头看一遍。');
      }
      notify('双卫答题助手', '视频巡航完成！本次共学完 ' + r.done + ' 节' +
        (lastScanSkipped > 0 ? '，' + lastScanSkipped + ' 节站点未记上' : ''));
    } else {
      log('未找到未学完课时（可能全部已学习，或页面结构与预期不同）。');
      log('提示：点「识别课时」看看脚本读到了哪些课时链接。');
    }
  }

  /* ============================================================
   * 12b. 视频播放页：真正探测「播完」→ 计数 → 推进下一节
   *
   *  v3 的 driver 只有一条路：找到「下一节」按钮就点。
   *  但这类站点大多没有「下一节」按钮（或在跨域 iframe 里、或是纯图标），
   *  于是「学完」这个事件根本没被检测到，一节课之后就彻底停住 —— 正是用户遇到的症状。
   *
   *  v4 换成三级判据：
   *    ① <video>.ended 或 currentTime 到达 duration-1.5（最可靠）
   *    ② 页面出现「本节学习完成 / 恭喜完成」等文案
   *    ③ 停留超过「剩余时长 + 5 分钟」的硬兜底（视频在跨域 iframe 里读不到进度时靠它）
   *  学完 → finishLesson()：计数落库 → 页内有「下一节」就先点 → 没生效/没有就回课程列表。
   * ========================================================== */
  var NEXT_CUE = /^下一(?:节|集|章|课时|讲|课)|^继续下一|^学习下一|^下一条/;
  var FINISH_TEXT = /(?:本节|本课时|本课|当前课时).{0,6}(?:学习)?(?:完成|已学完|学完)|恭喜.{0,8}(?:完成|学完)|课时学习完成|学习已完成|已完成本(?:节|课)/;

  function isDisabledEl(el) {
    if (!el) return true;
    try {
      if (el.disabled) return true;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
      if (/\bdisabled\b/i.test(String(el.className || ''))) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  // 找视频页的「下一节」入口：优先按钮/链接文字匹配，其次 aria/title
  function findNextLessonEntry() {
    var cands = document.querySelectorAll(
      'a,button,input[type="button"],input[type="submit"],[role="button"],' +
      '.next,.btn-next,.next-btn,.next-chapter,[class*="next"]'
    );
    var picked = null;
    Array.prototype.forEach.call(cands, function (el) {
      if (picked) return;
      var t = (el.innerText || el.value || el.getAttribute('title') || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 20) return;
      if (NEXT_CUE.test(t)) picked = el;
    });
    return picked;
  }

  // 收集 video：本页 + 同源 iframe 里的（跨域 iframe 读不到，交给兜底逻辑）
  function getAllVideos() {
    var out = [];
    try {
      var v = document.querySelectorAll('video');
      for (var i = 0; i < v.length; i++) out.push(v[i]);
    } catch (e) { /* ignore */ }
    try {
      var ifr = document.querySelectorAll('iframe');
      for (var j = 0; j < ifr.length; j++) {
        var d = null;
        try { d = ifr[j].contentDocument; } catch (e2) { d = null; }
        if (!d) continue;
        var iv = d.querySelectorAll('video');
        for (var k = 0; k < iv.length; k++) out.push(iv[k]);
      }
    } catch (e3) { /* ignore */ }
    return out;
  }

  // 这一页像不像视频页
  function isVideoPage() {
    try { if (getAllVideos().length) return true; } catch (e) { /* ignore */ }
    return !!document.querySelector(
      '.prism-player,.video-js,[id*="player"],[class*="player"],[id*="video"],[class*="video"],' +
      'iframe[src*="video"],iframe[src*="player"],iframe[src*="vedio"],iframe[src*="media"],iframe[src*="play"]'
    );
  }

  // 有没有「真正的课程播放器」（排除课程列表页上的宣传小视频/封面视频）
  function hasRealPlayer() {
    var vids = getAllVideos();
    for (var i = 0; i < vids.length; i++) {
      try {
        var d = vids[i].duration;
        if (!(d > 0) || d >= 20) return true;   // 时长未知（未加载）或够长 → 认为是真的
      } catch (e) { return true; }
    }
    return !!document.querySelector(
      '.prism-player,.video-js,[class*="player"],iframe[src*="player"],iframe[src*="video"],iframe[src*="vedio"],iframe[src*="media"]'
    );
  }

  var pageEnterAt = Date.now();
  var pageFinished = false;
  var lastProgress = -1;
  var lastProgressAt = 0;
  var forcePlayCount = 0;
  var warnedNoVideo = false;
  var pageStartCur = -1;   // 进入本页时的播放位置
  var pageEntryCur = -1;   // 视频元数据就绪时的播放位置（判断「一进来就在结尾」用）
  var pageMaxCur = 0;      // 本页播放到过的最大进度（防止播放器播完把 currentTime 归零后判不出来）
  var nearEndSince = 0;    // 进度到达「最后 20 秒」的起始时间（站点卡在片尾时的兜底）
  var startedAtEndWarned = false;
  var startedAtEndTries = 0;
  var restartRetryAt = 0;   // 上次尝试「拉回开头」的时间（10 秒后校验是否生效）
  var seekChecked = false;  // 本页是否已做过「续播位置」检查
  var pageFinishedAt = 0;   // 本页判定学完的时间（滞留兜底用）
  var lastHeartbeatAt = 0;  // 上次巡航心跳日志时间
  var lastDiagAt = 0;       // 上次自检日志时间

  // 取「主视频」（时长最长那个），避免贴片/封面小视频乱判
  function videoState() {
    var vids = getAllVideos();
    var primary = null, best = -1;
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i], d = 0;
      try { d = (v.duration && isFinite(v.duration)) ? v.duration : 0; } catch (e) { d = 0; }
      if (d > best) { best = d; primary = v; }
      if (cfg.playbackRate && cfg.playbackRate !== 1) {
        try { if (v.playbackRate !== cfg.playbackRate) v.playbackRate = cfg.playbackRate; } catch (e2) { /* ignore */ }
      }
    }
    if (!primary) primary = vids[0] || null;
    var dur = 0, cur = 0, ended = false, paused = true;
    if (primary) {
      try {
        dur = (primary.duration && isFinite(primary.duration)) ? primary.duration : 0;
        cur = primary.currentTime || 0;
        ended = !!primary.ended;
        paused = !!primary.paused;
        if (dur > 0 && cur > 0 && cur >= dur - 1.5) ended = true;
      } catch (e3) { /* ignore */ }
    }
    // 时长 <20 秒的「小视频」已结束不算学完（贴片/封面），防止秒刷
    if (ended && dur > 0 && dur < 20) ended = false;
    return { dur: dur, cur: cur, ended: ended, paused: paused, n: vids.length, v: primary };
  }

  // 播放页判定「本节播完」：只挂待核对记录，**不直接计数**
  function finishLesson(reason) {
    if (pageFinished) return;
    pageFinished = true;
    pageFinishedAt = Date.now();
    var key = pageKey();
    var st = load();
    if (st.__cruiseDoneKey === key) {
      // ★ 同一课时重复判定（页面被站点/脚本重载过）：不再计数，但必须继续推进，
      //   否则会永远停在播完的播放页上（v4.3 的「学完不跳下一节」就是这里卡死）
      log('本课时已判定过 → 继续回列表核对/推进');
      setTimeout(function () { advanceToNext(reason); }, 6000);
      return;
    }
    st.__cruiseDoneKey = key;
    st.__cruiseSeen = st.__cruiseSeen || {};
    st.__cruiseSeen[key] = (st.__cruiseSeen[key] || 0) + 1;
    // ★ v4.2：这里不计数！回列表核对站点「已学」通过后才 +1（否则就是假学完）
    var pend = st.__cruisePending || { key: key, title: (document.title || '').slice(0, 60), tries: 0 };
    pend.finished = true;
    pend.reason = reason;
    pend.finishAt = Date.now();
    st.__cruisePending = pend;
    save(st);
    log('✓ 本节播放完毕（' + reason + '）→ 回列表核对站点是否记为「已学」');
    // 给站点 8 秒把学习记录落库，再回列表（跳太早站点可能不算学时）
    setTimeout(function () { advanceToNext(reason); }, 8000);
  }

  // 学完后一律回课程列表：只有回到列表才能核对站点状态、也才能正确挑下一节
  // （v4.2 去掉了「直接点下一节」的捷径 —— 那条路会让「是否被站点记为已学」无从核对）
  function advanceToNext(reason) {
    goBackToList(reason);
  }

  // ★ 站点把上次播放位置存在 localStorage（key 形如 会员号_课时id_项目id）。
  //   若残留在结尾附近，先清掉它再拉回开头重播——否则每次进来都从结尾续播，
  //   真实播放秒数不够，服务器判 study_time_abnormal 不记学时 → 反复重进死循环。
  //   返回 true 表示「本次做了重播」，调用方不要再判「已学完」。
  function restartNearEndIfNeeded(s) {
    if (!cfg.restartIfNearEnd || !s || !s.v || !(s.dur > 60) || !(s.cur > s.dur - 15) || !(s.cur > 5)) return false;
    try {
      var sid = (location.search.match(/study_id=([0-9a-f-]+)/i) || [])[1];
      if (sid && window.localStorage) {
        for (var li = localStorage.length - 1; li >= 0; li--) {
          var lk = localStorage.key(li);
          if (!lk || lk.indexOf('_' + sid + '_') === -1) continue;
          var lv = parseFloat(localStorage.getItem(lk));
          if (lv >= s.dur - 60) {
            localStorage.removeItem(lk);
            log('…清除站点残留播放位置 ' + Math.round(lv) + 's（' + lk.slice(0, 40) + '）');
          }
        }
      }
    } catch (e0) { /* ignore */ }
    try {
      log('…视频从 ' + Math.round(s.cur) + 's/' + Math.round(s.dur) + 's 处续播（太靠后）→ 拉回开头重播，避免站点不认学时');
      s.v.currentTime = 0;
      pageStartCur = 0;
      pageEntryCur = 0;
      pageMaxCur = 0;    // 重播了，之前「到过结尾」的记录必须作废，否则下一拍就误判学完
      var pv = s.v.play();
      if (pv && pv.catch) pv.catch(function () { });
      return true;
    } catch (e) { return false; }
  }

  // 主循环：每 1.5 秒看一次
  function tickVideo() {
    var stv = load();
    var cruisingNow = !!(stv.__cruise && stv.__cruiseFrom);
    var pendingDone = !!(stv.__cruisePending && stv.__cruisePending.finished);
    // ★ v4.5 解耦：即使巡航标记被清掉，只要本页有「已判定播完但还没回列表」的记录，
    //   也要继续推进——否则就会出现「视频播完了却一动不动」的静默卡死。
    if (!cruisingNow && !pendingDone) return;
    resetPageIfChanged();

    var nowT = Date.now();
    // 自检心跳：每分钟把关键判定写进日志，排障时不用猜（v4.5）
    if (nowT - lastDiagAt > 60000) {
      lastDiagAt = nowT;
      var ds = videoState();
      log('[自检] 巡航=' + (cruisingNow ? '开' : '关') + ' 视频页=' + (isVideoPage() ? '是' : '否') +
        ' 已判完=' + (pageFinished ? '是' : '否') + ' 待核对=' + (stv.__cruisePending ? '有' : '无') +
        ' 弹窗=' + (popDialogVisible() ? '在' : '无') +
        ' 进度=' + Math.round(ds.cur) + '/' + Math.round(ds.dur) + (ds.ended ? '（已到结尾）' : ''));
      log('       巡航起点=' + String(stv.__cruiseFrom || '(空)').slice(0, 80));
    }

    // ★ 兜底：本页已判学完但 60 秒后仍滞留（advance 失效/被拦截）→ 强制回列表
    //   v4.6：不再受弹窗门控——弹窗常年可见时，这条兜底以前也一起失效了
    if (pageFinished) {
      if (pageFinishedAt && Date.now() - pageFinishedAt > 60000) {
        pageFinishedAt = Date.now();
        log('…判完 60s 仍滞留本页 → 强制回列表推进');
        goBackToList('完成后滞留强制推进');
      }
      return;
    }
    if (!isVideoPage()) return;

    // ★★ v4.6 核心修复：先判「是否已播完」，再判弹窗。
    //   你日志里的死锁：video 已经 4202/4202 播到结尾，但 popVisible 一直 true，
    //   于是 tickVideo 每次都在下面那行 return，永远走不到「判完」分支，
    //   自检就一直是「已判完=否」，一节课播完了脚本却一动不动。
    var sPre = videoState();
    if (sPre.dur > 0 && pageEntryCur < 0) pageEntryCur = sPre.cur;
    if (sPre.cur > pageMaxCur) pageMaxCur = sPre.cur;
    // 续播位置检查放在最前面：万一视频停在结尾（站点记忆），先拉回开头重播，别直接判「学完」
    // ★ 必须等 duration 就绪（>0）才算做过检查，否则「元数据还没加载」会被当成「已检查」，
    //   之后视频从结尾处续播就再也拉不回来了 —— 这正是「假学完」反复出现的漏洞。
    if (!seekChecked && sPre.dur > 0) {
      seekChecked = true;
      if (restartNearEndIfNeeded(sPre)) return;
    }
    // 一进来就已经在结尾（站点记的位置）→ 不算学完，也不能判完成。
    // ★ 判据要「起点在结尾」且「现在仍在结尾」：拉回开头成功后进度会掉到 0，
    //   这时就不能再算「起点在结尾」了，否则正常播完时会被误判、白白跳过。
    var startedAtEnd = (sPre.dur > 60 && pageEntryCur >= sPre.dur - 30 && sPre.cur >= sPre.dur - 30);
    // 上一次尝试拉回开头后，10 秒还贴在结尾 → 判定拉不回来，跳过这节
    if (restartRetryAt && (nowT - restartRetryAt) > 10000) {
      restartRetryAt = 0;
      if (sPre.dur > 60 && sPre.cur >= sPre.dur - 30) {
        if (!startedAtEndWarned) {
          startedAtEndWarned = true;
          log('⚠ 本节起点在结尾且拉不回开头（' + Math.round(sPre.cur) + 's/' + Math.round(sPre.dur) +
            's），站点不会认这段学时 → 跳过这节，换下一节。');
          log('   这节需要你手动把播放器拖到开头看一遍。');
          setTimeout(function () { goBackToList('起点在结尾，无法重播'); }, 3000);
        }
        return;
      }
      // 拉回成功：把「起点」改记成 0，否则播到真结尾时会被误判成「起点在结尾」而跳过
      pageEntryCur = 0;
      log('…已回到开头继续播放（' + Math.round(sPre.cur) + 's），这次从头看');
    }
    var preAtEnd = sPre.ended || (sPre.dur > 20 && (sPre.cur >= sPre.dur - 1 || pageMaxCur >= sPre.dur - 1));
    if (preAtEnd && !startedAtEnd && sPre.dur >= 20 && (nowT - pageEnterAt) >= 20000 &&
        (sPre.cur >= sPre.dur - 5 || (pageStartCur >= 0 && sPre.cur - pageStartCur > 3))) {
      finishLesson('播放到结尾 ' + Math.round(sPre.cur) + 's/' + Math.round(sPre.dur) + 's');
      return;
    }
    if (startedAtEnd) {
      // ★ 先试着自己拉回开头（站点可能只是把上次位置记在结尾）
      if (startedAtEndTries < 3) {
        startedAtEndTries++;
        restartRetryAt = nowT;
        log('…本节起点在 ' + Math.round(pageEntryCur) + 's/' + Math.round(sPre.dur) +
          's（站点记住的位置），拉回开头重播（第 ' + startedAtEndTries + ' 次）');
        try {
          sPre.v.currentTime = 0;
          pageStartCur = 0;
          pageMaxCur = 0;
          var pv0 = sPre.v.play();
          if (pv0 && pv0.catch) pv0.catch(function () { });
        } catch (e) { /* ignore */ }
        return;
      }
      return;
    }

    // ★ 站点中途弹题（10 分钟准时弹「您是否在线」并 pause 视频）可见时：
    //   推进/续播/超时统计全部停手，交给 handleOnlineDialog 勾选提交，答完自动续播。
    if (popDialogVisible()) {
      lastProgressAt = Date.now();   // 弹窗期间不计入「进度卡死」
      return;
    }
    // 读不到 <video>（多半在跨域 iframe 里）→ 提前说明兜底策略，别让用户干等
    if (!getAllVideos().length && !warnedNoVideo) {
      warnedNoVideo = true;
      log('⚠ 本页有播放器容器但读不到 <video>（多半在跨域 iframe 里）。');
      log('  将按「单页上限 ' + (cfg.lessonMaxMin || 45) + ' 分钟」兜底推进；等不及就点「强制学完」。');
    }

    var now = Date.now();
    var s = videoState();
    var dwell = now - pageEnterAt;

    // 巡航心跳：每 5 分钟报一次进度，避免面板长时间无输出看起来像挂了
    if (now - lastHeartbeatAt > 300000) {
      lastHeartbeatAt = now;
      var hbCur = Math.floor(s.cur / 60) + ':' + ('0' + Math.round(s.cur % 60)).slice(-2);
      var hbDur = s.dur > 0 ? (Math.floor(s.dur / 60) + ':' + ('0' + Math.round(s.dur % 60)).slice(-2)) : '?';
      log('…巡航中 ' + hbCur + ' / ' + hbDur + (s.paused ? '（暂停）' : '（播放中）'));
    }

    // 记录进入本页时的播放位置，确认「这一页真的播过」（防止误判后一节秒过一节）
    if (pageStartCur < 0) pageStartCur = s.cur;
    var playedThisLoad = (s.cur - pageStartCur > 3) || (s.dur > 0 && s.cur >= s.dur - 5);

    // ★ 站点会记住上次播放位置。若一进来就已经在结尾附近，说明这一节并没有真正播完，
    //   站点也多半不会认学时 → 拉回开头重播一遍（"假学完"最常见的原因）。
    if (!seekChecked && s.dur > 0) { seekChecked = true; restartNearEndIfNeeded(s); }

    // ① 视频真的播到结尾（最可靠）；至少停留 20 秒。
    //    ★ v4.7 重要修正：站点只有在**播放到最后一刻**时才把 is_complete=1 写回服务器。
    //      之前脚本在「剩最后 20 秒」就判完跳走，剩下 20 秒没播 → 站点不认 → 回列表仍显示
    //      「未学」→ 重进再学 → 永远刷不完。现在必须先到 ended / 距结尾 1 秒以内。
    //      只有站点自己卡在片尾（进度停在 dur-20 一动不动）才用兜底判完成。
    var atEnd = s.ended || (s.dur > 20 && (s.cur >= s.dur - 1 || pageMaxCur >= s.dur - 1));
    var nearEnd = s.dur > 20 && s.cur >= s.dur - 20;
    if (!atEnd && nearEnd) {
      if (!nearEndSince) { nearEndSince = now; log('…已到片尾 20 秒内，等它真正播完（不要提前跳，否则站点不记学时）'); }
    } else if (!nearEnd) {
      nearEndSince = 0;
    }
    var stuckAtEnd = (nearEnd && nearEndSince && now - nearEndSince > 180000);   // 卡在片尾 3 分钟
    if ((atEnd || stuckAtEnd) && s.dur >= 20 && dwell >= 20000 && playedThisLoad) {
      if (s.dur > 300 && (s.cur - pageStartCur) < 120 && pageStartCur > 0) {
        log('⚠ 本节本次真实播放仅约 ' + Math.round(Math.max(0, s.cur - pageStartCur)) + 's/' +
          Math.round(s.dur) + 's，若回列表仍显示未学，需要从头完整重看一遍');
      }
      finishLesson(atEnd
        ? '播放到结尾 ' + Math.round(s.cur) + 's/' + Math.round(s.dur) + 's'
        : '卡在片尾 3 分钟，按完成处理（兜底）');
      return;
    }

    // ② 页面文案：只在「读不到 video」时作为依据，且必须已停留 90 秒
    if (s.n === 0 && dwell > 90000) {
      var bodyTxt = '';
      try { bodyTxt = (document.body && document.body.innerText) || ''; } catch (e) { /* ignore */ }
      if (bodyTxt && FINISH_TEXT.test(bodyTxt)) { finishLesson('页面提示学习完成'); return; }
    }

    // ③ 进度不动 → 反复续播
    if (s.n) {
      if (Math.abs(s.cur - lastProgress) > 0.5 || lastProgress < 0) {
        lastProgress = s.cur;
        lastProgressAt = now;
      }
      if (!lastProgressAt) lastProgressAt = now;
      if (now - lastProgressAt > 12000) {
        forcePlayCount++;
        log('…进度 ' + Math.round((now - lastProgressAt) / 1000) + 's 未动，第 ' + forcePlayCount + ' 次尝试续播');
        lastProgressAt = now;
        autoPlayVideo(true);
      }
      // 3 分钟还没开始播 → 不要把课刷过去（那等于整门课都"假学完"），停下来问人
      if (s.n > 0 && lastProgress <= 1 && now - pageEnterAt > 180000) {
        pageFinished = true;
        log('✗ 3 分钟内视频始终没开始播放，已暂停巡航（不跳过，避免整门课都假学完）。');
        log('   请手动点一下播放按钮/处理页面弹窗，然后回课程页重新点「自动巡航」。');
        cruiseStop();
        try { notify('双卫答题助手', '视频没播起来，巡航已暂停，请手动点播放'); } catch (e) { /* ignore */ }
        return;
      }
    }

    // ④ 硬兜底：停留超过「剩余时长 + 5 分钟」（或配置上限）
    var limitMs = (s.dur > 0)
      ? Math.max(0, s.dur - s.cur) * 1000 + 5 * 60 * 1000
      : (cfg.lessonMaxMin || 60) * 60 * 1000;
    if (now - pageEnterAt > limitMs) {
      finishLesson('单页停留超过上限 ' + Math.round(limitMs / 60000) + ' 分钟');
    }
  }

  /* ============================================================
   * 12c. 视频自动播放：弹窗处理完视频常停在暂停状态，自动点播放
   *      同时处理「上次观看 XX 继续播放」提示。
   * ========================================================== */
  var lastPlayAttempt = 0;
  function autoPlayVideo(force) {
    if (!cruiseOn()) return;
    // ★ 弹题未答完时绝不续播：站点弹「您是否在线」就是故意暂停等你作答，
    //   在弹窗后面强行 play 可能被判学习异常（study_time_abnormal）
    if (popDialogVisible()) return;
    var now = Date.now();
    if (!force && now - lastPlayAttempt < 4000) return;   // 4 秒防抖（force=进度卡死时的强制续播）
    lastPlayAttempt = now;

    // 1) 先点「继续播放」提示（右下角「上次观看 XX 继续播放」）
    var resumeEls = document.querySelectorAll('a,span,button,div,[class*="resume"],[class*="continue"]');
    for (var r = 0; r < resumeEls.length; r++) {
      var rt = (resumeEls[r].innerText || '').replace(/\s+/g, ' ').trim();
      if (/继续播放/.test(rt) && rt.length <= 20 && isVisible(resumeEls[r])) {
        try { resumeEls[r].click(); log('★ 自动续播：点「继续播放」'); return; } catch (e) { }
      }
    }

    // 2) HTML5 video 暂停时直接调 play()
    var vids = document.querySelectorAll('video');
    for (var v = 0; v < vids.length; v++) {
      var vid = vids[v];
      if (vid.paused && !vid.ended) {
        try {
          var pp = vid.play();
          if (pp && pp.catch) pp.catch(function () { });
          log('★ 自动播放：video.play()');
          return;
        } catch (e) { }
      }
    }

    // 3) 播放器容器可能有自己的播放按钮（大三角），paused 时点一下
    var player = document.querySelector('.prism-player,.video-js,[class*="player"],[class*="video"]');
    if (player) {
      // 播放器内暂停状态通常有播放按钮（class 含 play/pause/大三角）
      var pbtn = player.querySelector('[class*="play-btn"],[class*="playBtn"],[class*="big-play"],[class*="pause"],.vjs-big-play-button,.prism-big-play-btn');
      if (pbtn && isVisible(pbtn)) {
        try { pbtn.click(); log('★ 自动播放：点播放按钮'); return; } catch (e) { }
      }
    }
  }

  /* ============================================================
   * 13. 视频页弹窗（您是否在线 / 播放进度跳转 等）
   *     这些弹窗挡住播放器，巡航时自动点掉。
   *     旧脚本只处理「您是否在线」，漏了「检测到播放进度是否跳转」这种。
   * ========================================================== */
  // 视频页可能出现的弹窗文案（命中任一即处理）
  // 注：站点有「是否在线」「您是在线?」两种写法，都要覆盖
  var VIDEO_DIALOG_CUE = /是否在线|您是在线|是在线|请确认在线|检测到您|播放进度|跳转至播放|是否跳转|继续播放|上次播放|断点/;
  var VIDEO_DIALOG_SEL = '.dati-dialog,#dialog-win,.tip-win,.layer,.layui-layer,' +
    '.modal,.dialog,[class*="dialog"],[class*="modal"],[class*="layer"],[class*="popup"],[role="dialog"]';
  // 人脸/身份认证弹窗：需要摄像头拍本人，脚本绝不能代替，也不能误点它的按钮
  var FACE_CUE = /人脸|身份认证|摄像头|活体检测/;

  // ★ v4.6：把弹窗文案分成两类，别再混为一谈。
  //   POP_BLOCK_CUE 才是「站点主动暂停、必须作答」的弹窗（10 分钟「您是否在线」）。
  //   POP_INFO_CUE  只是提示（续播/断点/跳转），不会暂停视频，绝不能拿它阻断推进。
  //   之前混用 VIDEO_DIALOG_CUE 导致播放器里的「继续播放」提示常年可见，
  //   tickVideo 每 1.5 秒都在第一行 return，于是视频播到结尾也永远判不出来。
  var POP_BLOCK_CUE = /是否在线|您是在线|是在线|请确认在线/;
  var POP_INFO_CUE = /检测到您|播放进度|跳转至播放|是否跳转|继续播放|上次播放|断点/;

  // 「您是否在线」这类中途弹题是否正显示（可见 + 命中文案 + 不在播放器控件内）
  function findBlockingDialog() {
    try {
      var all = document.querySelectorAll(VIDEO_DIALOG_SEL);
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!isVisible(el)) continue;
        if (!POP_BLOCK_CUE.test(el.innerText || '')) continue;
        // 播放器自己的控件/提示层里也有类似文案，排除掉
        if (el.closest && el.closest('video,.prism-player,.video-js,[class*="prism"],[class*="xgplayer"]')) continue;
        return el;
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function popDialogVisible() { return !!findBlockingDialog(); }

  // 站点部分弹窗绑的是 mousedown/pointer 事件，单纯 .click() 不触发 → 补发完整事件序列
  function hardClick(el) {
    if (!el) return;
    try {
      var opt = { bubbles: true, cancelable: true, view: window };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
        try {
          var Ev = (/^pointer/.test(t) && window.PointerEvent) ? window.PointerEvent : window.MouseEvent;
          el.dispatchEvent(new Ev(t, opt));
        } catch (e1) { /* ignore */ }
      });
      try { el.click(); } catch (e2) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }

  // 勾选「A、是」这类选项：优先真实点击 label（站点的校验多绑在 label/click 上，
  // 直接改 .checked 有时提交上去是空答案 → 弹窗点了不消失，这正是 18:17/18:28 的现象）
  function answerOption(container) {
    if (!container) return false;
    var opt = container.querySelector(
      'input[type="checkbox"],input[type="radio"]'
    ) || container.querySelector('label,[class*="option"],[class*="radio"],[class*="check"]');
    if (!opt) return false;
    var inp = (opt.tagName === 'INPUT') ? opt : container.querySelector('input[type="checkbox"],input[type="radio"]');
    if (inp && inp.checked) return true;
    var lab = (opt.closest && opt.closest('label')) || (inp && inp.closest && inp.closest('label'));
    if (lab) hardClick(lab);
    else hardClick(opt);
    if (inp && !inp.checked) {
      try {
        inp.checked = true;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) { /* ignore */ }
    }
    return true;
  }

  // 弹窗「点了不消失」的看门狗状态
  var popClickCount = 0;
  var popFirstSeenAt = 0;
  var popLastText = '';
  var lastPopClickAt = 0;

  function handleOnlineDialog() {
    // ★ 防抖：同一个弹窗别每 1.2 秒点一次（连续点会把站点的校验打乱）
    var sinceClick = Date.now() - lastPopClickAt;
    if (sinceClick < (popClickCount >= 5 ? 15000 : 4000)) return;
    try {
      // ★ 弹窗可能带勾选框（如「您是在线? A.是」），必须先勾选再点提交。
      //   优先在弹窗容器内操作，避免误点答题表单的提交按钮。
      var all = document.querySelectorAll(VIDEO_DIALOG_SEL);
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!isVisible(el)) continue;
        var t = el.innerText || '';
        if (!VIDEO_DIALOG_CUE.test(t)) continue;
        // ★ 人脸/身份认证弹窗：必须本人开摄像头，脚本不碰，只提醒
        if (FACE_CUE.test(t) && !/是否在线|您是在线/.test(t)) {
          log('⚠ 检测到人脸/身份认证弹窗，需要你本人完成（脚本不能代答）。');
          try { notify('双卫答题助手', '视频页弹出身份认证，请手动完成'); } catch (e0) { }
          return;
        }
        // 找到了弹窗容器，先勾选框再点确认。
        // ★ 按钮优先级：确认/确定/提交 > 继续播放 > 是/继续。
        //   因为「是」常出现在弹窗正文里（如「是否跳转」的「是」），
        //   排在前面会点到正文而非按钮，所以要放最后。
        // ★ 多题弹窗：每个 .dati-cont 组勾第一个选项；没有分组就勾第一个勾选框
        // ★ 多题弹窗：每个 .dati-cont 组勾第一个选项；没有分组就勾该弹窗第一组选项
        var groups = el.querySelectorAll('.dati-cont');
        if (groups.length) {
          for (var gi = 0; gi < groups.length; gi++) answerOption(groups[gi]);
        } else {
          answerOption(el);
        }
        var btn = null;
        var btns = el.querySelectorAll('button,a,.dati-btn,input[type="button"],input[type="submit"],.btn,[role="button"],span');
        for (var pri = 0; pri < 3 && !btn; pri++) {
          for (var j = 0; j < btns.length; j++) {
            var bt = (btns[j].innerText || btns[j].value || '').trim();
            if (!bt || bt.length > 8) continue;   // 按钮文字一般很短，排除正文
            var hit;
            if (pri === 0) hit = (bt === '确认' || bt === '确定' || bt === '提交' || /跳转至播放/.test(bt));
            else if (pri === 1) hit = (bt === '继续' || /继续播放/.test(bt));
            else hit = (bt === '是');
            if (hit) { btn = btns[j]; break; }
          }
        }
        if (btn) {
          popClickCount++;
          lastPopClickAt = Date.now();
          if (!popFirstSeenAt) { popFirstSeenAt = Date.now(); popLastText = String(t).slice(0, 60); }
          log('处理视频页弹窗：点「' + (btn.innerText || '').trim() + '」（第 ' + popClickCount + ' 次）');
          if (popClickCount === 1) btn.click(); else hardClick(btn);
          // 提交后弹窗关闭、视频会保持暂停 → 稍候自动恢复播放
          var verifyEl = el, verifyBtn = btn, verifyTxt = String(t).slice(0, 60);
          setTimeout(function () {
            // ★ 校验是否真的关掉了：没关掉说明点错了元素/事件没绑上，记录下来别继续空转
            var stillOpen = false;
            try {
              stillOpen = isVisible(verifyEl) && POP_BLOCK_CUE.test(verifyEl.innerText || '') &&
                String(verifyEl.innerText || '').slice(0, 60) === verifyTxt;
            } catch (e0) { stillOpen = false; }
            if (stillOpen) {
              log('⚠ 弹窗点了没关掉（第 ' + popClickCount + ' 次），改用补发事件再点一次');
              hardClick(verifyBtn);
              if (popClickCount >= 3) {
                try {
                  log('⚠ 弹窗持续 ' + Math.round((Date.now() - popFirstSeenAt) / 1000) + 's 未关闭，DOM 片段如下：');
                  log('   ' + String(verifyEl.outerHTML || '').replace(/\s+/g, ' ').slice(0, 500));
                } catch (e1) { /* ignore */ }
              }
            } else {
              popClickCount = 0; popFirstSeenAt = 0; popLastText = '';
              if (cruiseOn()) { autoPlayVideo(true); log('弹窗已关闭，恢复播放'); }
            }
          }, 2500);
          return;
        }
      }

      // 容器没命中 → 按文案全局搜确认按钮（兜底，可能误点但概率低）
      try {
        if (VIDEO_DIALOG_CUE.test(document.body.innerText || '')) {
          var gb = document.querySelectorAll('button,a,input[type="button"],input[type="submit"],.btn,[role="button"]');
          for (var k = 0; k < gb.length; k++) {
            if (!isVisible(gb[k])) continue;
            var gt = (gb[k].innerText || gb[k].value || '').trim();
            if (gt === '确认' || gt === '确定' || gt === '提交') {
              // 人脸/认证弹窗里的按钮绝不自动点
              var anc = gb[k].closest ? gb[k].closest('[class*="dialog"],[class*="modal"],[class*="layer"],[class*="popup"]') : null;
              if (anc && FACE_CUE.test(anc.innerText || '')) continue;
              log('处理视频页弹窗（全局）：点「' + gt + '」');
              gb[k].click();
              setTimeout(function () {
                if (cruiseOn()) { autoPlayVideo(true); log('弹窗已提交，恢复播放'); }
              }, 2500);
              return;
            }
          }
        }
      } catch (e3) { /* ignore */ }
    } catch (e) { /* ignore */ }

    // ★ 弹窗可能在 iframe 里（视频播放器常嵌 iframe），遍历同源 iframe 处理。
    try {
      var iframes = document.querySelectorAll('iframe');
      for (var f = 0; f < iframes.length; f++) {
        var win = iframes[f].contentWindow;
        var doc = iframes[f].contentDocument;
        if (!win || !doc) continue;                       // 跨域 iframe 访问会被拒，跳过
        if (win.__swwDialogHooked) continue;              // 该 iframe 已处理过
        var idlg = null;
        var iall = doc.querySelectorAll(VIDEO_DIALOG_SEL);
        for (var k2 = 0; k2 < iall.length; k2++) {
          var iel = iall[k2];
          if (!isVisibleIframe(iel, win)) continue;
          if (!VIDEO_DIALOG_CUE.test(iel.innerText || '')) continue;
          idlg = iel; break;
        }
        if (!idlg) continue;
        var icb = idlg.querySelector('input[type="checkbox"]');
        if (icb && !icb.checked) {
          icb.checked = true;
          icb.dispatchEvent(new win.Event('change', { bubbles: true }));
        }
        // ★ 与主页面一致：确认/确定/提交 > 继续播放 > 是（避免点到正文里的「是」）
        var iok = null;
        var ibtns = idlg.querySelectorAll('button,a,.dati-btn,input[type="button"],input[type="submit"],.btn,[role="button"],span');
        for (var ipri = 0; ipri < 3 && !iok; ipri++) {
          for (var k3 = 0; k3 < ibtns.length; k3++) {
            var ikt = (ibtns[k3].innerText || ibtns[k3].value || '').trim();
            if (!ikt || ikt.length > 8) continue;
            var ihit;
            if (ipri === 0) ihit = (ikt === '确认' || ikt === '确定' || ikt === '提交' || /跳转至播放/.test(ikt));
            else if (ipri === 1) ihit = (ikt === '继续' || /继续播放/.test(ikt));
            else ihit = (ikt === '是');
            if (ihit) { iok = ibtns[k3]; break; }
          }
        }
        if (iok) {
          log('处理 iframe 内视频弹窗：点「' + (iok.innerText || '').trim() + '」');
          iok.click();
          win.__swwDialogHooked = true;
        }
      }
    } catch (e2) { /* 跨域 iframe 无法访问，忽略 */ }
  }

  // iframe 内元素可见性判断（用 iframe 的 window.getComputedStyle）
  function isVisibleIframe(n, win) {
    if (!n) return false;
    try {
      var st = win.getComputedStyle(n);
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    } catch (e) { return false; }
  }

  /* ============================================================
   * 14. 启动
   * ========================================================== */
  function isExamPage() {
    // ★ v4.6：课时播放页绝不算答题页（站点「您是否在线」弹窗也用了 .dati-* 组件，
    //   不排除的话巡航会把播放页当答题页，日志里那句「本页是答题页，跳过」就是误判）
    if (/studyVideo/i.test(location.pathname)) return false;
    return /\/(studyExam|dati|exam|online|answer|test)/i.test(location.pathname) ||
      document.querySelector('.online-dati,.online-dati-title,.dati-cont,.dati-item') !== null;
  }

  // 只看 DOM 判断是不是答题页。
  // ⚠ 不能用 isExamPage()：它按 URL 关键字匹配，站点的课程/课时页路径里也常带 online，
  //   巡航时会被误判成答题页 → 提前 return → 永远不去找下一节课（v3 的第二个坑）。
  function isQuestionPage() {
    try {
      // 播放页先排除：站点的在线确认弹窗内部就是 .dati-cont 结构
      if (/studyVideo/i.test(location.pathname) || hasRealPlayer()) return false;
      var els = document.querySelectorAll(
        '.online-dati-title,.online-dati,.dati-cont,.dati-item,.dati-wenti,.dati-sub'
      );
      for (var i = 0; i < els.length; i++) {
        // 弹窗里的题面不算答题页
        if (els[i].closest && els[i].closest('.dati-dialog,[class*="dialog"],[class*="modal"],[class*="popup"]')) continue;
        return true;
      }
      return false;
    } catch (e) { return false; }
  }

  // 诊断用：列出脚本在当前页面识别到的课时链接及状态，方便你确认「视频巡航」能不能用
  function listLessons() {
    var links = document.querySelectorAll(
      'a[href*="study"],a[href*="lesson"],a[href*="chapter"],a[href*="catalog"],' +
      'a[href*="video"],a[href*="player"],a[href*="course"],a[href*="online"],' +
      'a[href*="study_id"],a[href*="project"],a[href*="apply"],' +
      'a[href*="play"],a[href*="vedio"],a[href*="media"],' +
      'li a,td a,.catalog a,.chapter a,.lesson a,.item a,tr a,dd a,dt a'
    );
    var seen = {}, seenMapNow = seenMap(), shown = 0;
    log('--- 课时链接识别（视频巡航用）---');
    Array.prototype.forEach.call(links, function (a) {
      if (!a || !a.href) return;
      var linkTxt = (a.innerText || '').replace(/\s+/g, ' ').trim();
      var rowTxt = rowTextOf(a).replace(/\s+/g, ' ').trim();
      var txt = linkTxt || rowTxt;
      if (!txt) return;
      var key = a.href + '|' + txt.slice(0, 20);
      if (seen[key]) return;
      seen[key] = 1;
      var st;
      if (isRowDone(a, rowTxt)) st = '已完成(跳过)';
      else if (LESSON_ANSWER_CUE.test(txt) && !LESSON_VIDEO_CUE.test(txt)) st = '答题链接(巡航跳过)';
      else if (/未学/.test(txt) || /未学/.test(rowTxt)) st = '★未学(巡航首选)';
      else if (/学习中/.test(txt) || /学习中/.test(rowTxt)) st = '★学习中(续播)';
      else if (/视频/.test(txt)) st = '视频链接(巡航目标)';
      else if (LESSON_VIDEO_CUE.test(txt)) st = '视频相关(巡航目标)';
      else st = '其他';
      var cnt = seenMapNow[String(a.href).split('#')[0].replace(/\/+$/, '')] || 0;
      log('  [' + st + ']' + (cnt ? '(已进过' + cnt + '次)' : '') + ' ' + txt.slice(0, 44));
      shown++;
    });
    log('共识别 ' + shown + ' 个链接。有「★未学/★学习中」就能巡航；全被标「已完成」或都是「其他」请把日志发我。');
  }

  function buildBar() {
    try {
      var bar = document.createElement('div');
      bar.id = 'sww-auto-bar';
      bar.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:rgba(15,20,30,.93);color:#e2e8f0;border:1px solid #3a4a5a;border-radius:8px;padding:6px 8px;font:12px/1.6 Consolas,monospace;display:flex;gap:6px;align-items:center;box-shadow:0 6px 18px rgba(0,0,0,.4);';
      var mk = function (label, title, fn, color) {
        var b = document.createElement('button');
        b.textContent = label; b.title = title;
        b.style.cssText = 'border:0;background:' + (color || '#2563eb') + ';color:#fff;border-radius:5px;padding:4px 9px;cursor:pointer;font:12px/1.4 Consolas,monospace;';
        b.addEventListener('click', fn);
        return b;
      };
      bar.appendChild(mk('识别', '只识别题目不作答', function () {
        var qs = extractQuestions();
        log('识别到 ' + qs.length + ' 题');
        qs.forEach(function (q) {
          log('  第' + q.num + '题 ' + q.stem.slice(0, 46));
          log('     ' + q.opts.map(function (o) { return o.letter + ')' + o.text.slice(0, 22); }).join(' | '));
        });
      }));
      // 推荐主流程：仅勾选 → 你自己看置信度 → 自己交卷
      bar.appendChild(mk('仅勾选', '只勾答案不交卷（推荐，自己交）', function () { runExam({ submit: false }); }, '#7c3aed'));
      bar.appendChild(mk('填答并交卷', '勾选并自动交卷', function () { runExam({ submit: true }); }, '#16a34a'));
      // ★ 手动记录：你手动勾选正确答案后点这个，答案永久入库，下次直接命中（★★★★★）
      bar.appendChild(mk('记录答案', '把当前手动勾选的答案存入题库，下次直接命中', function () {
        var qs = extractQuestions();
        var n = 0;
        qs.forEach(function (q) {
          var l = checkedLetters(q);
          if (l.length) { recordBank(q, l); n++; }
        });
        log('已记录 ' + n + ' 题的答案入题库（下次命中 ★★★★★）');
        notify('双卫答题助手', '已记录 ' + n + ' 题答案入题库。');
      }, '#b45309'));
      // ★ 视频巡航：在课程详情页点它，脚本自动逐个进未学完课时、挂视频、处理在线弹窗、跳下一节
      bar.appendChild(mk('识别课时', '只识别课时链接不作答（视频巡航诊断）', function () { listLessons(); }, '#0891b2'));
      bar.appendChild(mk('自动巡航', '自动学视频：进未学完课时→处理在线弹窗→跳下一节，直到本课程学完', function () {
        cruiseStart(location.href);
        log('★ 视频巡航已启动。将自动逐个学习本课程未学完课时（不答题）。');
        notify('双卫答题助手', '视频巡航已启动，正在查找未学完课时…');
        setTimeout(handleProjectDetail, 1200);
      }, '#dc2626'));
      bar.appendChild(mk('停巡航', '停止视频巡航', function () {
        var r = cruiseStop();
        log('已停止视频巡航。本次共学完 ' + r.done + ' 节。');
      }, '#64748b'));
      bar.appendChild(mk('强制学完', '当前视频读不到进度/卡住时，手动判定本节学完并推进下一节', function () {
        if (!cruiseOn()) { log('当前不在巡航中：先点「自动巡航」。'); return; }
        if (isVideoPage()) finishLesson('手动强制');
        else { log('本页不是视频页，直接找下一课时'); handleProjectDetail(); }
      }, '#ea580c'));
      bar.appendChild(mk('清已学记录', '清空「已进过的课时」记录（配合自动巡航可强制重学所有课）', function () {        var st = load();
        st.__cruiseSeen = {};
        st.__cruiseSkip = {};
        st.__cruisePending = null;
        st.__cruiseDoneKey = '';
        save(st);
        log('已清空已学记录。下次「自动巡航」会从头重进所有课时。');
        notify('双卫答题助手', '已清空已学记录。');
      }, '#7c2d12'));
      bar.appendChild(mk('巡航状态', '查看巡航状态与页面角色（排障用）', function () {
        var st = load();
        var seen = st.__cruiseSeen || {};
        log('--- 巡航状态 ---');
        log('  开启: ' + (st.__cruise ? '是' : '否') + '  站点已确认学完: ' + (st.__cruiseCount || 0) + ' 节');
        var pd = st.__cruisePending;
        log('  待核对: ' + (pd ? (String(pd.title || '').slice(0, 24) + ' | finished=' + (pd.finished ? '是' : '否') + ' | 重试' + (pd.tries || 0) + '次') : '无'));
        log('  来源页: ' + (st.__cruiseFrom || '(空)'));
        log('  当前页: ' + pageKey());
        log('  已进过的课时: ' + Object.keys(seen).length + ' 个');
        log('  页面判定: 视频页=' + (isVideoPage() ? '是' : '否') +
          ' / 答题页=' + (document.querySelector('.online-dati-title,.dati-cont,.dati-item,.online-dati') ? '是' : '否') +
          ' / video 数量=' + getAllVideos().length);
        var s = videoState();
        log('  视频: ' + (s.n ? ('时长 ' + Math.round(s.dur) + 's / 进度 ' + Math.round(s.cur) + 's / ' + (s.ended ? '已播完' : (s.paused ? '暂停' : '播放中'))) : '未读到 <video>'));
        log('  本页停留: ' + Math.round((Date.now() - pageEnterAt) / 1000) + 's');
      }, '#0d9488'));
      bar.appendChild(mk('复制日志', '把日志面板全部内容+状态复制到剪贴板（发给开发者排障）', function () {
        var p = logPanel || document.getElementById('sww-auto-log');
        var txt = (p && p.dataset.lines) || '(无日志)';
        var stx = load();
        txt += '\n--- 状态(v4.5) ---\n' + JSON.stringify({
          url: location.href,
          cruise: !!stx.__cruise,
          from: stx.__cruiseFrom,
          confirmed: stx.__cruiseCount || 0,
          pending: stx.__cruisePending,
          doneKey: stx.__cruiseDoneKey,
          seen: Object.keys(stx.__cruiseSeen || {}).length,
          isVideo: isVideoPage(),
          video: (function () { var v = videoState(); return { n: v.n, dur: Math.round(v.dur), cur: Math.round(v.cur), ended: v.ended, paused: v.paused }; })(),
          popVisible: popDialogVisible()
        }, null, 1);
        var done = function (ok) {
          log(ok ? '✓ 日志已复制到剪贴板，直接粘贴发给我' : '复制失败：请手动截图日志面板');
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(function () { done(true); }, function () { fallback(); });
          } else { fallback(); }
        } catch (e) { fallback(); }
        function fallback() {
          try {
            var ta = document.createElement('textarea');
            ta.value = txt;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(ta); ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            done(ok);
          } catch (e2) { done(false); }
        }
      }, '#334155'));
      bar.appendChild(mk('重置', '清除进度与题库', function () {
        memStore = {};
        try { if (typeof GM_setValue === 'function') GM_setValue(LS_KEY, {}); } catch (e) { /* ignore */ }
        try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
        log('已清除本地进度与题库');
      }, '#475569'));
      var stt = document.createElement('span');
      stt.textContent = '策略:' + cfg.strategy + (cfg.aiEndpoint ? '+AI' : '') + ' 重答:' + (cfg.autoRetry ? '开' : '关');
      stt.style.color = '#94a3b8';
      bar.appendChild(stt);
      (document.body || document.documentElement).appendChild(bar);
    } catch (e) { /* ignore */ }
  }

  function boot() {
    // 关键：尽早接管 confirm/alert，避免原生阻塞弹窗卡死页面
    installNativeDialogHook(handleResult);
    installDialogWatcher(handleResult);

    document.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); runExam({ submit: true }); }
      if (e.altKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); runExam({ submit: false }); }
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); runExam({ submit: true }); }
    }, true);

    buildBar();
    setInterval(handleOnlineDialog, 1500);
    // ★ 视频巡航主循环：探测播完 → 计数 → 推进下一节（v4 替换了旧的 driveVideoPage）
    setInterval(tickVideo, 1500);
    // ★ 巡航时自动点播放，避免弹窗处理完视频停在暂停状态
    setInterval(function () { autoPlayVideo(false); }, 2500);

    // ★ 播放器在子 iframe 里时，iframe 判定播完会 postMessage 过来，由顶层负责跳回列表
    window.addEventListener('message', function (e) {
      var d = e && e.data;
      if (!d || !d.__swwLessonDone) return;
      if (!cruiseOn()) return;
      log('★ 播放器 iframe 报告本课时学完 → 返回课程列表');
      setTimeout(function () { goBackToList('iframe 报告完成'); }, 1200);
    }, false);

    function route() {
      // ★ 视频巡航优先：巡航模式下答题页不答题，视频页交给 tickVideo，其余当课程列表处理
      var stR = load();
      var cruiseMode = !!(stR.__cruise && stR.__cruiseFrom) || !!stR.__cruisePending;
      if (cruiseMode) {
        // ★ 按 URL 先定性（最可靠），再用 DOM 兜底：
        //   列表页里常有一堆 class 带 video 的小图标，用 DOM 判会误判成播放页，
        //   于是回到列表后永远不去点下一节课（这就是「回不到列表继续学」的另一种成因）。
        var pth = location.pathname, qs = location.search;
        if (/studyVideo/i.test(pth) || /study_id=/i.test(qs)) {
          log('★ 视频巡航：视频页，自动播放中（播完自动下一节）');
          return;
        }
        if (/projectDetail|searchProject|studyList|myProfile|course/i.test(pth)) {
          setTimeout(handleProjectDetail, 1200);
          return;
        }
        if (isQuestionPage()) {
          log('★ 视频巡航：本页是答题页，巡航只学视频，跳过。');
          return;
        }
        if (hasRealPlayer()) {
          log('★ 视频巡航：视频页，自动播放中（播完自动下一节）');
          return;
        }
        // 兜底：当课程页处理
        setTimeout(handleProjectDetail, 1500);
        return;
      }

      if (isExamPage()) {
        if (!document.querySelector('.online-dati-title,.dati-cont,.dati-item,.online-dati')) {
          setTimeout(route, 1200); return;
        }
        if (cfg.autoSubmit) {
          setTimeout(function () { runExam({ submit: true }); }, 1500);
        } else {
          log('答题页就绪。Alt+A 填答并交卷，Alt+B 只填答，Ctrl+Enter 交卷。');
        }
      } else if (/projectDetail|myProfile|searchProject|studyList/.test(location.pathname)) {
        setTimeout(handleProjectDetail, 2000);
      }
    }
    setTimeout(route, 1200);
  }

  if (!window.__swwV3Started) {
    window.__swwV3Started = true;
    // ★ iframe 模式：视频播放器常嵌在 iframe 里，弹窗在 iframe 内。
    //   脚本在 iframe 里只负责点掉视频弹窗 + 探测播完（不跑答题/控制条，避免重复）。
    var inIframe = inIframeCtx();
    if (inIframe) {
      var iframeBoot = function () {
        setInterval(handleOnlineDialog, 1200);
        // ★ iframe 内视频弹窗处理完也可能停在暂停状态，自动点播放
        setInterval(function () { autoPlayVideo(false); }, 2500);
        // ★ v4：iframe 里也要探测「播完」，否则播放器嵌 iframe 时永远不会推进下一节
        setInterval(tickVideo, 1500);
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iframeBoot, { once: true });
      } else {
        iframeBoot();
      }
      return;
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
})();
