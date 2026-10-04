"use strict";

// 前端交错场景测试用的最小浏览器环境：无第三方依赖。
// 提供可断言的假 DOM、可手动放行的 fetch（响应顺序完全可控），
// 以及假 setInterval（只保留 / 清除 / 手动触发，不随真实时间走动）。

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "static", "app.js");

function makeClassList() {
  const set = new Set();
  return {
    add(c) {
      set.add(c);
    },
    remove(c) {
      set.delete(c);
    },
    toggle(c, force) {
      if (force === undefined) force = !set.has(c);
      if (force) set.add(c);
      else set.delete(c);
    },
    contains(c) {
      return set.has(c);
    },
  };
}

function makeElement(id, opts = {}) {
  const listeners = {};
  const el = {
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    value: opts.value !== undefined ? opts.value : "",
    title: "",
    scrollTop: 0,
    dataset: opts.dataset || {},
    classList: makeClassList(),
    _listeners: listeners,
    _children: [],
    _innerHTML: "",
    appendChild(child) {
      this._children.push(child);
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    click() {
      for (const fn of listeners.click || []) fn.call(el);
    },
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return el._innerHTML;
    },
    set(v) {
      el._innerHTML = String(v);
      el._children = [];
    },
  });
  return el;
}

// 排空 Promise 链（应用内部多次 await 串联）
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function loadApp(search = "") {
  const elements = new Map();
  const get = (id, opts) => {
    if (!elements.has(id)) elements.set(id, makeElement(id, opts));
    return elements.get(id);
  };

  // 甲、乙两栏按钮（与 index.html 中五个 data-op 一致）
  const opButtons = { a: [], b: [] };
  for (const side of ["a", "b"]) {
    get(`panel-${side}`);
    get(`add-input-${side}`, { value: "10" });
    for (const op of ["begin", "read", "add", "commit", "rollback"]) {
      const btn = makeElement(`op-${side}-${op}`, { dataset: { op } });
      opButtons[side].push(btn);
    }
  }
  for (const id of [
    "exp-id",
    "new-exp",
    "delete-exp",
    "committed",
    "refresh-committed",
    "deleted-note",
    "error-exp",
    "tx-a",
    "dot-a",
    "read-a",
    "error-a",
    "log-a",
    "tx-b",
    "dot-b",
    "read-b",
    "error-b",
    "log-b",
    "checkpoint",
    "ckpt-result",
    "log-ckpt",
    "error-ckpt",
    "ckpt-passive",
    "ckpt-truncate",
  ]) {
    get(id);
  }

  const selectorMap = {
    "#panel-a button, #panel-a input": [
      ...opButtons.a,
      elements.get("add-input-a"),
    ],
    "#panel-b button, #panel-b input": [
      ...opButtons.b,
      elements.get("add-input-b"),
    ],
    "#panel-a button[data-op]": opButtons.a,
    "#panel-b button[data-op]": opButtons.b,
  };

  const documentStub = {
    getElementById: (id) => elements.get(id),
    querySelectorAll: (sel) => selectorMap[sel] || [],
    createElement: (tag) => makeElement("created-" + tag),
  };

  // 假定时器：手动触发，绝不在真实时间上走动
  const intervals = new Map();
  let nextTimerId = 1;
  const setIntervalStub = (cb) => {
    const id = nextTimerId++;
    intervals.set(id, cb);
    return id;
  };
  const clearIntervalStub = (id) => {
    intervals.delete(id);
  };
  const tickTimers = (times = 1) => {
    for (let i = 0; i < times; i++) {
      for (const cb of [...intervals.values()]) cb();
    }
  };

  // 可脚本化的 fetch：每个请求入队 pending，由测试决定何时、以什么响应放行
  const calls = [];
  const fetchStub = (url, options = {}) => {
    const entry = {
      path: url,
      method: options.method || "GET",
      body: options.body,
      settled: false,
    };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    calls.push(entry);
    return entry.promise;
  };

  const makeResponse = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  const findCall = (includes, method, opts = {}) =>
    calls.find(
      (c) =>
        !c.settled &&
        (opts.exact ? c.path === includes : c.path.includes(includes)) &&
        (!method || c.method === method)
    );

  const settle = (includes, status, body, method, opts = {}) => {
    const entry = findCall(includes, method, opts);
    if (!entry) throw new Error(`没有在途请求匹配 ${includes} (${method || "ANY"})`);
    entry.settled = true;
    entry.resolve(makeResponse(status, body));
    return entry;
  };

  const rejectRequest = (includes, err, method, opts = {}) => {
    const entry = findCall(includes, method, opts);
    if (!entry) throw new Error(`没有在途请求匹配 ${includes}`);
    entry.settled = true;
    entry.reject(err);
    return entry;
  };

  const historyStub = {
    url: search || "/",
    replaceState(_s, _t, url) {
      this.url = url;
    },
  };

  const sandbox = {
    console,
    document: documentStub,
    window: { confirm: () => true },
    history: historyStub,
    location: { search, pathname: "/" },
    fetch: fetchStub,
    setInterval: setIntervalStub,
    clearInterval: clearIntervalStub,
    URLSearchParams,
  };
  vm.createContext(sandbox);

  const exportShim = `
    ;globalThis.__app = {
      get expId() { return expId; },
      get expFrozen() { return expFrozen; },
      get creating() { return typeof creating !== "undefined" ? creating : null; },
      get expGen() { return expGen; },
      get timerCount() {
        return (statusTimer !== null ? 1 : 0) + (committedTimer !== null ? 1 : 0);
      },
      newExperiment,
    };
  `;
  const source = fs.readFileSync(APP_JS, "utf8") + exportShim;
  vm.runInContext(source, sandbox, { filename: "app.js" });

  return {
    app: () => sandbox.__app,
    el: (id) => elements.get(id),
    opButton: (side, op) =>
      opButtons[side].find((b) => b.dataset.op === op),
    calls,
    findCall,
    settle,
    rejectRequest,
    tickTimers,
    intervalCallbacks: () => [...intervals.values()],
    history: historyStub,
    setConfirm: (fn) => {
      sandbox.window.confirm = fn;
    },
  };
}

// 构造与后端接口同形的响应体
function statusBody(expId, opts = {}) {
  const side = (read, log, inTx) => ({
    in_transaction: !!inTx,
    last_read: read === undefined ? null : read,
    log: log || [],
  });
  return {
    id: expId,
    a: side(opts.aRead, opts.aLog, opts.aTx),
    b: side(opts.bRead, opts.bLog, opts.bTx),
    checkpoint: { last: opts.ckptLast || null, log: opts.ckptLog || [] },
  };
}

const OLD_STATUS = () =>
  statusBody("OLD", {
    aRead: 1110,
    aLog: ["OLD-a-log"],
    bRead: 1111,
    bLog: ["OLD-b-log"],
    ckptLast: {
      mode: "PASSIVE",
      busy: 1,
      log_frames: 9,
      checkpointed: 0,
      wal_size: 4152,
    },
    ckptLog: ["OLD-ckpt-log"],
  });
const NEW_STATUS = () =>
  statusBody("NEW", {
    aRead: 2220,
    aLog: ["NEW-a-log"],
    bRead: 2221,
    bLog: ["NEW-b-log"],
  });

// 启动一个存活的 OLD 实验（?exp=OLD，初次 status / committed 放行后进入轮询）
async function bootOldLive(ctx) {
  await flush();
  // init：先 status
  const initStatus = ctx.calls.find((c) => c.path.includes("/OLD/status"));
  if (!initStatus) throw new Error("启动后未见 OLD status 请求");
  initStatus.settled = true;
  initStatus.resolve({
    status: 200,
    ok: true,
    json: async () => OLD_STATUS(),
  });
  await flush();
  // init：再 committed，然后 startPolling
  const initCommitted = ctx.calls.find((c) => c.path.includes("/OLD/committed"));
  if (!initCommitted) throw new Error("OLD status 放行后未见 committed 请求");
  initCommitted.settled = true;
  initCommitted.resolve({
    status: 200,
    ok: true,
    json: async () => ({ committed: 111 }),
  });
  await flush();
}

// 放行“手动新建 NEW”的完整收尾：POST 成功 + NEW 首次 status / committed
async function settleNewCreated(ctx) {
  ctx.settle("/api/experiments", 201, { id: "NEW" }, "POST", { exact: true });
  await flush();
  ctx.settle("/NEW/status", 200, NEW_STATUS());
  await flush();
  ctx.settle("/NEW/committed", 200, { committed: 222 });
  await flush();
}

module.exports = {
  loadApp,
  flush,
  statusBody,
  OLD_STATUS,
  NEW_STATUS,
  bootOldLive,
  settleNewCreated,
};
