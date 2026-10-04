/**
 * 前端「代际隔离」交错测试 —— 无第三方依赖，用 Node vm 直接加载 static/app.js，
 * 以完全可控的响应顺序复现新旧实验请求交错。
 *
 * 覆盖：
 *   A. 新建期间旧轮询暂停、旧操作禁用；点击新建前已在途的旧 ID 请求
 *      （轮询 200/404、操作 200/500、检查点 200/410、删除 200——
 *      成功、失败与 finally 收尾）一律不得改动新实验的值、日志、错误、
 *      按钮或冻结状态，也不得触发自动新建；创建成功后只有新 ID 在轮询。
 *   B. 已删除页面发起新建失败：显示错误、仍冻结（旧操作禁用、轮询停止）；
 *      手动重试成功后恢复正常。
 *   C. 存活页面新建失败（网络错误）：恢复旧实验控件并恢复旧 ID 轮询。
 *   D. 保留旧规则：404 自动新建且并发只建一次；410 冻结、不自动新建。
 *
 * 运行：node tests/frontend-interleave.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

async function run() {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("ok   - " + name);
    } catch (e) {
      failures++;
      console.error("FAIL - " + name);
      console.error(e && e.stack ? e.stack : e);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} 用例通过`);
  if (failures) process.exitCode = 1;
}

function makeHarness(search = "") {
  const byId = {};
  const listeners = {};
  let uidSeq = 0;

  function makeEl(tag = "div") {
    const el = {
      tag,
      _text: "",
      get textContent() {
        return this._text;
      },
      set textContent(v) {
        this._text = v === null || v === undefined ? "" : String(v);
      },
      innerHTML: "",
      title: "",
      hidden: tag === "input",
      disabled: false,
      value: "10",
      dataset: {},
      scrollTop: 0,
      scrollHeight: 1,
      children: [],
      _classes: new Set(),
      appendChild(child) {
        this.children.push(child);
      },
    };
    const uid = "el" + ++uidSeq;
    const map = {};
    el.addEventListener = (type, fn) => {
      map[type] = fn;
    };
    el.click = () => map.click && map.click();
    el.classList = {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, on) =>
        on === undefined ? el._classes.add(c) : on ? el._classes.add(c) : el._classes.delete(c),
      contains: (c) => el._classes.has(c),
    };
    listeners[uid] = map;
    return el;
  }

  const reg = (id, el) => {
    byId[id] = el;
    return el;
  };

  reg("exp-id", makeEl());
  byId["exp-id"].textContent = "…";
  reg("new-exp", makeEl("button"));
  reg("delete-exp", makeEl("button"));
  reg("committed", makeEl());
  byId["committed"].textContent = "…";
  reg("refresh-committed", makeEl("button"));
  reg("deleted-note", Object.assign(makeEl(), { hidden: true }));
  reg("error-exp", Object.assign(makeEl(), { hidden: true }));

  const opButtons = { a: [], b: [] };
  const controls = { a: [], b: [] };
  for (const side of ["a", "b"]) {
    reg("panel-" + side, makeEl("section"));
    reg("dot-" + side, makeEl());
    reg("tx-" + side, makeEl());
    byId["tx-" + side].textContent = "…";
    reg("read-" + side, makeEl());
    byId["read-" + side].textContent = "—";
    const input = reg("add-input-" + side, makeEl("input"));
    reg("error-" + side, Object.assign(makeEl(), { hidden: true }));
    reg("log-" + side, makeEl("ol"));
    for (const op of ["begin", "read", "add", "commit", "rollback"]) {
      const btn = makeEl("button");
      btn.dataset.op = op;
      opButtons[side].push(btn);
      controls[side].push(btn);
    }
    controls[side].push(input);
  }
  reg("checkpoint", makeEl("section"));
  reg("ckpt-passive", makeEl("button"));
  reg("ckpt-truncate", makeEl("button"));
  reg("ckpt-result", makeEl());
  byId["ckpt-result"].textContent = "尚未执行过检查点";
  reg("error-ckpt", Object.assign(makeEl(), { hidden: true }));
  reg("log-ckpt", makeEl("ol"));

  const documentStub = {
    getElementById: (id) => byId[id],
    createElement: () => makeEl("li"),
    querySelectorAll(sel) {
      const side = sel[7]; // "#panel-x ..."
      return sel.includes("[data-op]") ? opButtons[side] : controls[side];
    },
  };

  const intervals = new Map();
  let intervalSeq = 1;
  const pending = [];
  const calls = [];

  function fakeFetch(url, options = {}) {
    const method = options.method || "GET";
    const req = { url, method, body: options.body || null, settled: false };
    req.promise = new Promise((resolve, reject) => {
      req.resolve = (v) => {
        req.settled = true;
        resolve(v);
      };
      req.reject = (v) => {
        req.settled = true;
        reject(v);
      };
    });
    pending.push(req);
    calls.push(req);
    return req.promise;
  }

  const jsonResp = (status, payload) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  });
  const flush = (n = 40) => {
    let p = Promise.resolve();
    for (let i = 0; i < n; i++) p = p.then(() => {});
    return p;
  };

  const sandbox = {
    document: documentStub,
    fetch: fakeFetch,
    setInterval: (fn) => {
      const id = intervalSeq++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    history: { replaceState() {} },
    location: { search },
    URLSearchParams: class {
      constructor(s) {
        this.p = new URL("http://x/?" + (s || "").replace(/^\?/, "")).searchParams;
      }
      get(k) {
        return this.p.get(k);
      }
    },
    confirmResult: true,
    Promise,
    Error,
    TypeError,
    Object,
    Array,
    JSON,
    BigInt,
    Number,
    String,
    RegExp,
    Math,
    console,
  };
  sandbox.window = {
    confirm: () => sandbox.confirmResult,
  };

  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox);

  const label = (m, u) => m + " " + u;
  return {
    el: byId,
    pending,
    calls,
    intervals,
    flush,
    resp: jsonResp,
    find: (re) => pending.find((r) => !r.settled && re.test(label(r.method, r.url))),
    findAll: (re) => pending.filter((r) => !r.settled && re.test(label(r.method, r.url))),
    count: (re) => calls.filter((r) => re.test(label(r.method, r.url))).length,
    fireTimers() {
      for (const fn of [...intervals.values()]) fn();
    },
    clickOp(side, op) {
      opButtons[side].find((b) => b.dataset.op === op).click();
    },
    frozen(side) {
      return byId["panel-" + side]._classes.has("exp-frozen");
    },
    panelDisabled(side) {
      return controls[side].every((e) => e.disabled);
    },
    panelEnabled(side) {
      return controls[side].every((e) => !e.disabled);
    },
    logs(side) {
      return byId["log-" + side].children.map((c) => c.textContent);
    },
    ckptLogs() {
      return byId["log-ckpt"].children.map((c) => c.textContent);
    },
    errVisible(id) {
      return !byId["error-" + id].hidden;
    },
  };
}

const R = {
  create: /^POST .*\/api\/experiments$/,
  status: (id) => new RegExp("^GET .*" + id + "/status$"),
  committed: (id) => new RegExp("^GET .*" + id + "/committed$"),
  op: (id) => new RegExp("^POST .*" + id + "/conn/"),
  ckpt: (id) => new RegExp("^POST .*" + id + "/checkpoint"),
  del: (id) => new RegExp("^DELETE .*" + id + "$"),
};
const state = (over = {}) =>
  Object.assign({ in_transaction: false, last_read: null, log: [] }, over);

async function settle(h, re, response) {
  const req = h.find(re);
  assert.ok(req, "期望存在在途请求: " + re);
  req.resolve(response);
  await h.flush();
}
async function rejectReq(h, re, err) {
  const req = h.find(re);
  assert.ok(req, "期望存在在途请求: " + re);
  req.reject(err);
  await h.flush();
}

// ---------------------------------------------------------------------------
// A. 新建窗口的请求交错：旧请求全部作废，只有新 ID 生效
// ---------------------------------------------------------------------------
test("A. 新建前在途的旧请求（轮询200/404、操作200/500、检查点200/410、删除200）不得影响新实验", async () => {
  const h = makeHarness("?exp=oldid");
  await h.flush();

  // init：旧实验首轮 status / committed 正常
  await settle(h, R.status("oldid"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("oldid"), h.resp(200, { committed: 100 }));
  assert.strictEqual(h.intervals.size, 2);

  // 点击新建之前，先制造一批真实在途旧请求（按钮此刻仍可用）：
  h.clickOp("a", "read"); // 旧操作：甲读值（稍后 200，带旧读值/旧日志）
  assert.ok(h.panelDisabled("a"), "请求中只禁用甲栏");
  assert.ok(h.panelEnabled("b"), "两栏独立：乙栏不受甲栏请求影响");
  h.fireTimers(); // 旧轮询一轮：status + committed
  h.el["ckpt-passive"].click(); // 旧检查点 PASSIVE（稍后 200，带旧检查点状态/日志）
  h.el["ckpt-truncate"].click(); // 旧检查点 TRUNCATE（稍后 410）
  h.clickOp("b", "begin"); // 旧操作：乙 BEGIN（稍后 500，应报错给旧栏——但已作废）
  h.el["delete-exp"].click(); // 旧删除（确认框默认通过，稍后 200，且一直挂到最后）

  // 点击「新建实验」：创建窗口开始
  h.el["new-exp"].click();
  await h.flush();
  assert.strictEqual(h.intervals.size, 0, "创建期间旧轮询定时器必须摘除");
  assert.strictEqual(h.count(R.create), 1, "只有一个新建请求");
  assert.ok(h.panelDisabled("a") && h.panelDisabled("b"));
  assert.ok(h.el["ckpt-passive"].disabled && h.el["ckpt-truncate"].disabled);
  assert.ok(h.el["delete-exp"].disabled && h.el["refresh-committed"].disabled);
  assert.strictEqual(h.el["exp-id"].textContent, "…");
  assert.strictEqual(h.el["committed"].textContent, "…");
  assert.ok(!h.frozen("a") && !h.frozen("b"));
  assert.ok(h.el["deleted-note"].hidden);

  // —— 创建进行中，旧响应以任意顺序到达 ——
  // 1) 旧操作 200（成功 + 旧状态）
  await settle(
    h,
    R.op("oldid"),
    h.resp(200, {
      ok: true,
      error: null,
      state: state({ in_transaction: true, last_read: 999, log: ["STALE-OP-A 旧操作日志"] }),
    })
  );
  assert.ok(h.panelDisabled("a"), "旧操作 finally 收尾不得在创建中解禁甲栏");
  assert.strictEqual(h.el["read-a"].textContent, "—", "旧操作 200 不得覆盖读值");
  assert.deepStrictEqual(h.logs("a"), [], "旧操作 200 不得写入日志");
  assert.strictEqual(h.el["exp-id"].textContent, "…");

  // 2) 旧检查点 PASSIVE 200（成功 + 旧检查点结果/日志）
  await settle(
    h,
    R.ckpt("oldid"),
    h.resp(200, {
      ok: true,
      error: null,
      busy: 0,
      log_frames: 5,
      checkpointed: 5,
      wal_size: 4152,
      state: {
        last: { mode: "PASSIVE", busy: 0, log_frames: 5, checkpointed: 5, wal_size: 4152 },
        log: ["STALE-CKPT 旧检查点日志"],
      },
    })
  );
  assert.strictEqual(
    h.el["ckpt-result"].textContent,
    "尚未执行过检查点",
    "旧检查点 200 不得渲染检查点结果"
  );
  assert.deepStrictEqual(h.ckptLogs(), [], "旧检查点 200 不得写入检查点日志");
  assert.ok(h.el["ckpt-passive"].disabled, "旧检查点收尾不得解禁检查点按钮");

  // 3) 旧检查点 TRUNCATE 410（曾经的误解冻来源）
  await settle(h, R.ckpt("oldid"), h.resp(410));
  assert.ok(!h.frozen("a") && !h.frozen("b"), "旧 410 不得冻结创建中的页面");
  assert.ok(h.el["deleted-note"].hidden, "旧 410 不得展示删除说明");
  assert.strictEqual(h.count(R.create), 1, "旧 410 不得触发自动新建");

  // 4) 旧操作乙 500（失败 + finally 收尾）
  await settle(h, R.op("oldid"), h.resp(500));
  assert.ok(!h.errVisible("b"), "旧操作 500 不得在乙栏显示错误");
  assert.ok(h.panelDisabled("b"), "旧操作失败收尾不得解禁乙栏");

  // 5) 旧状态轮询 200（旧 200 覆盖读值的原始 bug）
  await settle(
    h,
    R.status("oldid"),
    h.resp(200, {
      a: state({ in_transaction: true, last_read: 111, log: ["STALE-STATUS 旧状态日志"] }),
      b: state(),
      checkpoint: { last: null, log: [] },
    })
  );
  assert.strictEqual(h.el["read-a"].textContent, "—", "旧状态 200 不得覆盖读值");
  assert.deepStrictEqual(h.logs("a"), [], "旧状态 200 不得写入日志");
  // tx-a 在创建成功前保持初始文本（创建成功后才重置为「…」）：
  // init 首轮渲染过「未开启」，旧 200 与该文本一致，这里校验关键信号——
  // 旧 200 的 in_transaction=true 不得让事务灯亮起
  assert.ok(!h.el["dot-a"]._classes.has("on"), "旧状态 200 不得改写事务指示");

  // 6) 旧已提交值轮询 404（不得自动新建）
  await settle(h, R.committed("oldid"), h.resp(404));
  assert.strictEqual(h.count(R.create), 1, "旧 404 不得在创建中触发自动新建");
  assert.strictEqual(h.el["committed"].textContent, "…");

  // 创建窗口内（点击「新建实验」之后）没有任何新增旧 ID 请求：
  // 总调用数仍是点击前那次 fireTimers 产生的各 1 次
  assert.strictEqual(h.count(R.status("oldid")), 2, "旧 status 总数 = init + 点击前 1 次轮询，窗口内无新增");
  assert.strictEqual(h.count(R.committed("oldid")), 2, "旧 committed 总数同上，窗口内无新增");

  // —— 创建成功 ——
  await settle(h, R.create, h.resp(200, { id: "newid" }));
  assert.ok(h.find(R.status("newid")), "成功后请求新 ID status");
  assert.ok(!h.find(R.committed("newid")), "首轮按顺序：committed 在 status 之后");

  // 新 status 200（新实验自己的读值与日志）
  await settle(
    h,
    R.status("newid"),
    h.resp(200, {
      a: state({ last_read: 100, log: [] }),
      b: state(),
      checkpoint: { last: null, log: [] },
    })
  );
  assert.ok(h.find(R.committed("newid")));
  await settle(h, R.committed("newid"), h.resp(200, { committed: 100 }));
  assert.strictEqual(h.intervals.size, 2, "成功后只为新 ID 启动轮询");

  // 新页面展示完全来自新 ID
  assert.strictEqual(h.el["exp-id"].textContent, "newid");
  assert.strictEqual(h.el["read-a"].textContent, "100");
  assert.strictEqual(h.el["committed"].textContent, "100");
  assert.deepStrictEqual(h.logs("a"), []);
  assert.deepStrictEqual(h.ckptLogs(), []);
  assert.strictEqual(h.el["ckpt-result"].textContent, "尚未执行过检查点");
  assert.ok(h.panelEnabled("a") && h.panelEnabled("b"));
  assert.ok(!h.el["ckpt-passive"].disabled && !h.el["ckpt-truncate"].disabled);
  assert.ok(!h.el["delete-exp"].disabled && !h.el["refresh-committed"].disabled);
  assert.ok(!h.frozen("a") && !h.frozen("b"));
  assert.ok(h.el["deleted-note"].hidden);
  assert.ok(!h.errVisible("a") && !h.errVisible("b") && !h.errVisible("ckpt"));

  // 7) 删除的迟到 200 在新页面轮询已启动后才收尾：不得冻结新实验
  await settle(h, R.del("oldid"), h.resp(200, { id: "oldid", deleted: true }));
  assert.ok(!h.frozen("a"), "旧删除成功不得冻结新实验");
  assert.ok(h.el["deleted-note"].hidden);
  assert.strictEqual(h.el["exp-id"].textContent, "newid");

  // 新轮询只面向新 ID，并能正常更新
  h.fireTimers();
  assert.strictEqual(h.count(R.status("oldid")), 2, "新轮询不再请求旧 ID（总数维持点击前）");
  assert.strictEqual(h.count(R.committed("oldid")), 2);
  assert.strictEqual(h.count(R.status("newid")), 2);
  assert.strictEqual(h.count(R.committed("newid")), 2);
  await settle(
    h,
    R.status("newid"),
    h.resp(200, {
      a: state({ last_read: 100, log: ["NEW-A 新实验日志", "NEW-A2 新实验第二条"] }),
      b: state(),
      checkpoint: { last: null, log: [] },
    })
  );
  await settle(h, R.committed("newid"), h.resp(200, { committed: 120 }));
  // 第二帧携带服务端完整日志（两条），整表重渲染为两条，无旧日志混入
  assert.deepStrictEqual(h.logs("a"), ["NEW-A 新实验日志", "NEW-A2 新实验第二条"]);
  assert.strictEqual(h.el["committed"].textContent, "120", "新 ID 轮询仍然存活");
  assert.strictEqual(h.count(R.create), 1, "全程只建过一次（新 ID）");
});

// ---------------------------------------------------------------------------
// B. 已删除页面新建失败 → 显示错误、仍冻结、轮询停止；重试成功恢复
// ---------------------------------------------------------------------------
test("B. 冻结页新建失败保持冻结并显示错误，手动重试成功后恢复正常", async () => {
  const h = makeHarness("?exp=deadid");
  await h.flush();

  // 已删除 ID：首轮 status 410 → 冻结，不自动新建
  await settle(h, R.status("deadid"), h.resp(410));
  assert.ok(h.frozen("a") && h.frozen("b"));
  assert.ok(h.panelDisabled("a") && h.panelDisabled("b"));
  assert.ok(h.el["delete-exp"].disabled && h.el["refresh-committed"].disabled);
  assert.ok(!h.el["deleted-note"].hidden);
  assert.strictEqual(h.intervals.size, 0, "410 后轮询停止");
  assert.strictEqual(h.count(R.create), 0, "410 不自动新建");

  // 冻结态下手动新建，失败（HTTP 500）
  const noteBefore = h.el["deleted-note"].textContent;
  h.el["new-exp"].click();
  await h.flush();
  assert.ok(h.panelDisabled("a") && h.panelDisabled("b"), "创建期间旧操作仍禁用");
  await settle(h, R.create, h.resp(500));

  // 失败后：误解冻不得发生
  assert.ok(h.frozen("a") && h.frozen("b"), "失败后必须回到冻结态");
  assert.ok(h.panelDisabled("a") && h.panelDisabled("b"), "旧操作仍禁用");
  assert.ok(h.el["ckpt-passive"].disabled && h.el["ckpt-truncate"].disabled);
  assert.ok(h.el["delete-exp"].disabled && h.el["refresh-committed"].disabled);
  assert.strictEqual(h.intervals.size, 0, "失败后轮询仍停止");
  assert.strictEqual(h.el["exp-id"].textContent, "deadid", "仍显示旧（已删除）ID");
  assert.ok(!h.el["deleted-note"].hidden, "删除说明仍在");
  assert.strictEqual(h.el["deleted-note"].textContent, noteBefore, "删除说明原文恢复");
  assert.ok(h.errVisible("exp"), "必须显示新建失败错误");
  assert.ok(h.el["error-exp"].textContent.includes("新建实验失败"));
  assert.strictEqual(h.count(R.status("deadid")), 1, "失败后不得补发旧 ID 请求");

  // 手动重试：第二次新建成功 → 恢复正常
  h.el["new-exp"].click();
  await h.flush();
  assert.strictEqual(h.count(R.create), 2);
  await settle(h, R.create, h.resp(200, { id: "newid2" }));
  await settle(
    h,
    R.status("newid2"),
    h.resp(200, {
      a: state({ last_read: 100, log: ["NEW2 日志"] }),
      b: state(),
      checkpoint: { last: null, log: [] },
    })
  );
  await settle(h, R.committed("newid2"), h.resp(200, { committed: 100 }));

  assert.ok(!h.frozen("a") && !h.frozen("b"), "重试成功后解除冻结");
  assert.ok(h.panelEnabled("a") && h.panelEnabled("b"));
  assert.ok(!h.el["delete-exp"].disabled && !h.el["refresh-committed"].disabled);
  assert.ok(h.el["deleted-note"].hidden);
  assert.ok(!h.errVisible("exp"), "成功后错误清除");
  assert.strictEqual(h.el["exp-id"].textContent, "newid2");
  assert.strictEqual(h.el["committed"].textContent, "100");
  assert.deepStrictEqual(h.logs("a"), ["NEW2 日志"]);
  assert.strictEqual(h.intervals.size, 2, "重试成功后轮询恢复");

  // 恢复后新轮询可用
  h.fireTimers();
  await settle(h, R.committed("newid2"), h.resp(200, { committed: 105 }));
  assert.strictEqual(h.el["committed"].textContent, "105");
  assert.strictEqual(h.count(R.status("deadid")), 1, "旧 ID 再无请求");
});

// ---------------------------------------------------------------------------
// C. 存活页面新建失败（网络异常）：恢复旧实验控件与旧 ID 轮询
// ---------------------------------------------------------------------------
test("C. 存活页新建失败恢复旧实验：控件启用、旧 ID 轮询继续", async () => {
  const h = makeHarness("?exp=oldid");
  await h.flush();
  await settle(h, R.status("oldid"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("oldid"), h.resp(200, { committed: 100 }));

  h.el["new-exp"].click();
  await h.flush();
  await rejectReq(h, R.create, new TypeError("Failed to fetch"));

  assert.strictEqual(h.el["exp-id"].textContent, "oldid", "恢复旧 ID 显示");
  assert.strictEqual(h.el["committed"].textContent, "100", "恢复旧已提交值显示");
  assert.ok(h.panelEnabled("a") && h.panelEnabled("b"));
  assert.ok(!h.el["ckpt-passive"].disabled && !h.el["delete-exp"].disabled);
  assert.ok(!h.frozen("a"));
  assert.ok(h.errVisible("exp") && h.el["error-exp"].textContent.includes("新建实验失败"));
  assert.strictEqual(h.intervals.size, 2, "旧实验轮询恢复");

  // 旧 ID 轮询继续工作
  h.fireTimers();
  await settle(h, R.status("oldid"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("oldid"), h.resp(200, { committed: 130 }));
  assert.strictEqual(h.el["committed"].textContent, "130");
});

// ---------------------------------------------------------------------------
// D. 保留规则：404 自动新建且并发只建一次；410 冻结不新建
// ---------------------------------------------------------------------------
test("D1. 首次打开未知 ID（404）自动新建一个实验", async () => {
  const h = makeHarness("?exp=ghostid");
  await h.flush();
  await settle(h, R.status("ghostid"), h.resp(404));
  assert.strictEqual(h.count(R.create), 1, "404 自动新建且仅一次");
  await settle(h, R.create, h.resp(200, { id: "newid3" }));
  await settle(h, R.status("newid3"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("newid3"), h.resp(200, { committed: 100 }));
  assert.strictEqual(h.intervals.size, 2);
  assert.strictEqual(h.el["exp-id"].textContent, "newid3");
});

test("D2. 存活实验的轮询同时收到两个 404：并发只建一次", async () => {
  const h = makeHarness("?exp=old4");
  await h.flush();
  await settle(h, R.status("old4"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("old4"), h.resp(200, { committed: 100 }));

  // 两条轮询在同一批次返回 404
  h.fireTimers();
  const s = h.find(R.status("old4"));
  const c = h.find(R.committed("old4"));
  s.resolve(h.resp(404));
  c.resolve(h.resp(404));
  await h.flush();
  assert.strictEqual(h.count(R.create), 1, "并发 404 共用同一个新建 Promise，只建一次");

  // 新建成功后恢复
  await settle(h, R.create, h.resp(200, { id: "newid4" }));
  await settle(h, R.status("newid4"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("newid4"), h.resp(200, { committed: 100 }));
  assert.strictEqual(h.el["exp-id"].textContent, "newid4");
  assert.strictEqual(h.intervals.size, 2);
});

test("D3. 当前实验收到 410：冻结、不自动新建；旧已提交值迟到响应不覆盖", async () => {
  const h = makeHarness("?exp=old5");
  await h.flush();
  await settle(h, R.status("old5"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("old5"), h.resp(200, { committed: 100 }));

  // 只触发第一个定时器（status 轮询），committed 不发出
  [...h.intervals.values()][0]();
  await h.flush();
  await settle(h, R.status("old5"), h.resp(410));

  assert.ok(h.frozen("a") && h.frozen("b"));
  assert.strictEqual(h.intervals.size, 0);
  assert.strictEqual(h.count(R.create), 0, "410 不触发自动新建");
  assert.ok(!h.el["deleted-note"].hidden);
  assert.ok(h.panelDisabled("a") && h.panelDisabled("b"));

  // 冻结态点击任何旧操作入口都不应发请求
  const callsBefore = h.calls.length;
  h.el["refresh-committed"].click();
  h.el["ckpt-passive"].click();
  h.clickOp("a", "begin");
  h.el["delete-exp"].click();
  await h.flush();
  assert.strictEqual(h.calls.length, callsBefore, "冻结态旧操作入口全部不发请求");

  // 「新建实验」仍可用
  h.el["new-exp"].click();
  await h.flush();
  assert.strictEqual(h.count(R.create), 1);
});

test("E. 创建中重复点击「新建实验」不重复建实验；冻结页新建收到 410 也算失败（保持冻结）", async () => {
  const h = makeHarness("?exp=dead6");
  await h.flush();
  await settle(h, R.status("dead6"), h.resp(410));
  assert.ok(h.frozen("a"));

  // 冻结态第一次新建；POST 在途时再点几次
  h.el["new-exp"].click();
  await h.flush();
  h.el["new-exp"].click();
  h.el["new-exp"].click();
  await h.flush();
  assert.strictEqual(h.count(R.create), 1, "创建中重复点击复用同一个 Promise");

  // POST 本身返回 410（服务端异常语义）：作为创建失败处理，保持冻结、显示错误
  await settle(h, R.create, h.resp(410));
  assert.ok(h.frozen("a") && h.frozen("b"), "创建请求自身的 410 不得解冻");
  assert.ok(h.panelDisabled("a") && h.panelDisabled("b"));
  assert.strictEqual(h.intervals.size, 0, "失败后不启动轮询");
  assert.ok(h.errVisible("exp"));
  assert.ok(h.el["error-exp"].textContent.includes("HTTP 410"));
  assert.strictEqual(h.el["exp-id"].textContent, "dead6");
});

test("F. 首次打开页面（无 ?exp）创建失败保持空态：不显示 null、不启动轮询", async () => {
  const h = makeHarness("");
  await h.flush();
  assert.strictEqual(h.count(R.create), 1, "首次加载自动新建");
  await settle(h, R.create, h.resp(502));

  assert.strictEqual(h.el["exp-id"].textContent, "…", "空态不渲染 null");
  assert.strictEqual(h.el["committed"].textContent, "…");
  assert.strictEqual(h.intervals.size, 0, "没有实验 ID 时不启动轮询");
  assert.ok(h.el["delete-exp"].disabled, "无实验可删");
  assert.ok(!h.el["refresh-committed"].disabled, "手动刷新按钮按原状可用");
  assert.ok(h.errVisible("exp") && h.el["error-exp"].textContent.includes("新建实验失败"));

  // 手动重试成功
  h.el["new-exp"].click();
  await h.flush();
  await settle(h, R.create, h.resp(200, { id: "newid7" }));
  await settle(h, R.status("newid7"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("newid7"), h.resp(200, { committed: 100 }));
  assert.strictEqual(h.el["exp-id"].textContent, "newid7");
  assert.strictEqual(h.intervals.size, 2);
  assert.ok(!h.errVisible("exp"));
});

test("G. 创建成功但新 ID 首轮 status 返回 410：冻结新页面、不自动新建", async () => {
  const h = makeHarness("?exp=old8");
  await h.flush();
  await settle(h, R.status("old8"), h.resp(200, { a: state(), b: state(), checkpoint: { last: null, log: [] } }));
  await settle(h, R.committed("old8"), h.resp(200, { committed: 100 }));

  h.el["new-exp"].click();
  await h.flush();
  await settle(h, R.create, h.resp(200, { id: "newid8" }));
  // 首轮 status 恰好 410（allowAutoCreate:false 下也不应新建，直接冻结）
  await settle(h, R.status("newid8"), h.resp(410));
  assert.ok(h.frozen("a") && h.frozen("b"));
  assert.strictEqual(h.intervals.size, 0);
  assert.strictEqual(h.count(R.create), 1, "首轮 410 不递归自动新建");
  assert.strictEqual(h.el["exp-id"].textContent, "newid8", "冻结的是新实验");
});

// 顺序执行全部用例
run();
