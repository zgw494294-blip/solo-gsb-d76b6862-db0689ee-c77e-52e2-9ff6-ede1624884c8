"use strict";

// 验证「新建实验」与旧实验在途请求交错时的前端隔离。
// 响应顺序完全由 settle* 控制，不依赖真实时间与真实网络。
// 运行：node tests/races.test.js

const {
  loadApp,
  flush,
  OLD_STATUS,
  NEW_STATUS,
  bootOldLive,
  settleNewCreated,
} = require("./harness");

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
  }
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name);
    console.error("      " + e.message);
  }
}

const newPendingCalls = (ctx, since) =>
  ctx.calls.slice(since).filter((c) => !c.settled);

// 旧实验的读值 / 日志 / 检查点展示不得出现在新页面
function assertShowsNewOnly(ctx, msg) {
  assertEq(ctx.el("read-a").textContent, 2220, `${msg}：甲读值不得被旧响应覆盖`);
  assertEq(ctx.el("read-b").textContent, 2221, `${msg}：乙读值不得被旧响应覆盖`);
  assertEq(ctx.el("committed").textContent, 222, `${msg}：已提交值不得被旧响应覆盖`);
  assert(
    ctx.el("log-a")._children.some((li) => li.textContent === "NEW-a-log"),
    `${msg}：甲日志应是新实验内容`
  );
  assert(
    !ctx.el("log-a")._children.some((li) => li.textContent === "OLD-a-log"),
    `${msg}：甲日志不得混入旧实验内容`
  );
  assert(
    !ctx.el("ckpt-result").textContent.includes("PASSIVE"),
    `${msg}：检查点展示不得被旧响应覆盖`
  );
}

async function main() {
  // 场景 1：手动新建期间暂停旧轮询；旧 status 200 迟到不得覆盖新实验
  await test("创建期间无旧 ID 请求；旧 200 迟到不覆盖新读值 / 日志 / 已提交值", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    assertEq(ctx.app().expId, "OLD", "前置：当前实验为 OLD");

    const countBefore = ctx.calls.length;
    ctx.el("new-exp").click();
    await flush();
    if (ctx.app().creating !== null) {
      assertEq(ctx.app().creating, true, "创建中 creating=true");
    }
    assertEq(ctx.app().timerCount, 0, "创建中轮询定时器已清除");
    assertEq(
      newPendingCalls(ctx, countBefore).filter((c) => c.path.includes("/OLD/")).length,
      0,
      "创建中不得向旧 ID 发任何请求"
    );

    // 已入队的迟到定时器回调也不得放行旧 ID 请求
    const queuedCount = ctx.calls.length;
    for (const cb of ctx.intervalCallbacks()) cb();
    await flush();
    assertEq(ctx.calls.length, queuedCount, "迟到的旧轮询回调不得发起请求");

    await settleNewCreated(ctx);
    assertEq(ctx.app().expId, "NEW", "创建成功后切到 NEW");
    assertEq(ctx.app().expFrozen, false, "新实验未冻结");
    assertEq(ctx.app().timerCount, 2, "新实验已启动两组轮询");
    assertShowsNewOnly(ctx, "新页面");

    // 创建期间从未发出旧 ID 请求，因此旧 ID 不可能存在迟到响应
    assertEq(
      ctx.calls.filter((c) => c.path.includes("/OLD/") && !c.settled).length,
      0,
      "旧 ID 不应存在任何在途请求"
    );
  });

  // 场景 2：旧轮询定时器在创建进行中触发（关键交错）——
  // 旧代码创建期间不停止轮询，回调读到新的 expGen 后仍向旧 ID 发请求；
  // 新建成功后该响应才到达：200 覆盖新读值，410 冻结新实验。
  for (const staleStatus of [200, 410]) {
    await test(`创建进行中触发的旧轮询，成功后返回 ${staleStatus}：不覆盖、不冻结`, async () => {
      const ctx = loadApp("?exp=OLD");
      await bootOldLive(ctx);

      // 点击新建，POST 在途（此刻新 expGen 已生效，但旧轮询定时器还在）
      const clickAt = ctx.calls.length;
      ctx.el("new-exp").click();
      await flush();
      if (ctx.app().creating !== null) {
        assertEq(ctx.app().creating, true, "创建中");
      }

      // 创建进行中，旧定时器恰好触发（回调此刻才读取 expGen）
      const cbs = ctx.intervalCallbacks();
      for (const cb of cbs) cb();
      await flush();
      const interlopers = ctx.calls
        .slice(clickAt)
        .filter((c) => c.path.includes("/OLD/") && !c.settled);

      // 新建成功并完成 NEW 的首次刷新、启动 NEW 轮询
      await settleNewCreated(ctx);
      assertEq(ctx.app().expId, "NEW", "创建成功后切到 NEW");
      assertShowsNewOnly(ctx, "交错响应到达前");

      if (interlopers.length > 0) {
        // 旧代码：这些携带新 expGen 的旧 ID 请求此刻才返回
        for (const call of interlopers) {
          call.settled = true;
          if (call.path.includes("/status")) {
            call.resolve({
              status: staleStatus,
              ok: staleStatus === 200,
              json: async () => (staleStatus === 200 ? OLD_STATUS() : {}),
            });
          } else {
            call.resolve({
              status: staleStatus,
              ok: staleStatus === 200,
              json: async () => (staleStatus === 200 ? { committed: 999 } : {}),
            });
          }
        }
        await flush();
      }

      assertEq(
        interlopers.length,
        0,
        "修复后创建进行中不得再向旧 ID 发出轮询请求"
      );
      assertEq(ctx.app().expId, "NEW", `旧 ${staleStatus} 后仍为 NEW`);
      assertEq(ctx.app().expFrozen, false, `旧 ${staleStatus} 不得冻结新实验`);
      assertEq(ctx.app().timerCount, 2, "新实验轮询仍在运行");
      assertEq(ctx.el("deleted-note").hidden, true, "不得显示删除冻结提示");
      assertShowsNewOnly(ctx, "交错响应处理后");
    });
  }

  // 场景 3：旧实验操作 / 检查点 / 删除请求的各类迟到响应均不得影响新实验
  for (const kind of [
    {
      name: "操作 200（成功）",
      fire(ctx) {
        ctx.opButton("a", "begin").click();
      },
      findPath: "/conn/a/op",
      method: "POST",
      respond(call) {
        call.settled = true;
        call.resolve({
          status: 200,
          ok: true,
          json: async () => ({
            ok: true,
            error: null,
            state: OLD_STATUS().a,
          }),
        });
      },
    },
    {
      name: "操作 410",
      fire(ctx) {
        ctx.opButton("a", "begin").click();
      },
      findPath: "/conn/a/op",
      method: "POST",
      respond(call) {
        call.settled = true;
        call.resolve({ status: 410, ok: false, json: async () => ({}) });
      },
    },
    {
      name: "检查点 200（busy=1）",
      fire(ctx) {
        ctx.el("ckpt-passive").click();
      },
      findPath: "/checkpoint/PASSIVE",
      method: "POST",
      respond(call) {
        call.settled = true;
        call.resolve({
          status: 200,
          ok: true,
          json: async () => ({
            ok: true,
            error: null,
            state: OLD_STATUS().checkpoint,
          }),
        });
      },
    },
    {
      name: "检查点 410",
      fire(ctx) {
        ctx.el("ckpt-passive").click();
      },
      findPath: "/checkpoint/PASSIVE",
      method: "POST",
      respond(call) {
        call.settled = true;
        call.resolve({ status: 410, ok: false, json: async () => ({}) });
      },
    },
    {
      name: "删除 200 成功收尾",
      fire(ctx) {
        ctx.el("delete-exp").click();
      },
      findPath: "OLD",
      method: "DELETE",
      respond(call) {
        call.settled = true;
        call.resolve({
          status: 200,
          ok: true,
          json: async () => ({ id: "OLD", deleted: true }),
        });
      },
    },
  ]) {
    await test(`旧${kind.name} 在新建成功后收尾：不冻结、不改值 / 日志 / 按钮`, async () => {
      const ctx = loadApp("?exp=OLD");
      await bootOldLive(ctx);

      const before = ctx.calls.length;
      kind.fire(ctx);
      await flush();
      const oldCall = ctx.calls
        .slice(before)
        .find((c) => c.path.includes(kind.findPath) && c.method === kind.method && !c.settled);
      assert(oldCall, `前置：旧${kind.name}请求已发出并在途`);

      ctx.el("new-exp").click();
      await flush();
      await settleNewCreated(ctx);

      // 旧请求此刻才收尾
      kind.respond(oldCall);
      await flush();

      assertEq(ctx.app().expId, "NEW", `旧${kind.name}后仍为 NEW`);
      assertEq(ctx.app().expFrozen, false, `旧${kind.name}不得冻结新实验`);
      assertEq(ctx.app().timerCount, 2, "新实验轮询不被停止");
      assertEq(ctx.el("deleted-note").hidden, true, "不显示冻结提示");
      assertShowsNewOnly(ctx, `旧${kind.name}收尾后`);
      assertEq(ctx.el("error-a").hidden, true, "旧操作错误不得写到新页面甲栏");
      assertEq(ctx.el("error-ckpt").hidden, true, "旧检查点错误不得写到新页面");
    });
  }

  // 场景 4：已删除页面手动新建失败 —— 显示错误、仍冻结、轮询停止；重试成功恢复
  await test("冻结页新建失败（网络错误）：显示错误、旧操作仍禁用、轮询停止；重试成功恢复", async () => {
    const ctx = loadApp("?exp=OLD");
    await flush();
    // init 拿到 410 → 冻结
    ctx.settle("/OLD/status", 410, {});
    await flush();
    assertEq(ctx.app().expFrozen, true, "前置：页面已冻结");
    assertEq(ctx.app().timerCount, 0, "前置：轮询停止");

    const countBefore = ctx.calls.length;
    ctx.el("new-exp").click();
    await flush();
    if (ctx.app().creating !== null) {
      assertEq(ctx.app().creating, true, "创建中");
    }
    assertEq(ctx.app().expFrozen, false, "创建中临时解除冻结样式");

    // POST 网络失败
    const post = ctx.findCall("/api/experiments", "POST", { exact: true });
    post.settled = true;
    post.reject(new TypeError("Failed to fetch"));
    await flush();

    if (ctx.app().creating !== null) {
      assertEq(ctx.app().creating, false, "失败后 creating 复位");
    }
    assertEq(ctx.app().expFrozen, true, "失败后恢复冻结");
    assertEq(ctx.app().timerCount, 0, "失败后轮询仍停止");
    assertEq(ctx.el("deleted-note").hidden, false, "仍显示删除提示");
    assertEq(ctx.el("error-exp").hidden, false, "顶部显示新建失败错误");
    assert(
      ctx.el("error-exp").textContent.includes("新建实验失败"),
      "错误文案应说明新建失败"
    );
    assertEq(
      newPendingCalls(ctx, countBefore).filter((c) => c.path.includes("/OLD/")).length,
      0,
      "失败后不得向旧 ID 发请求"
    );

    // 手动重试成功
    ctx.el("new-exp").click();
    await flush();
    await settleNewCreated(ctx);
    assertEq(ctx.app().expId, "NEW", "重试成功后切到 NEW");
    assertEq(ctx.app().expFrozen, false, "重试成功后解除冻结");
    assertEq(ctx.app().timerCount, 2, "重试成功后轮询恢复");
    assertEq(ctx.el("error-exp").hidden, true, "重试成功后清除失败错误");
    assertShowsNewOnly(ctx, "重试成功页面");
  });

  // 场景 4b：冻结页新建失败（HTTP 500）
  await test("冻结页新建失败（500）：显示错误并保持冻结", async () => {
    const ctx = loadApp("?exp=OLD");
    await flush();
    ctx.settle("/OLD/status", 410, {});
    await flush();

    ctx.el("new-exp").click();
    await flush();
    ctx.settle("/api/experiments", 500, {}, "POST", { exact: true });
    await flush();

    assertEq(ctx.app().expFrozen, true, "500 后仍冻结");
    assertEq(ctx.app().timerCount, 0, "500 后轮询停止");
    assertEq(ctx.el("error-exp").hidden, false, "500 显示错误");
  });

  // 场景 4c：存活页新建失败 —— 恢复旧实验控件与轮询
  await test("存活页新建失败：恢复旧实验控件并恢复轮询", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    const countBefore = ctx.calls.length;

    ctx.el("new-exp").click();
    await flush();
    const post = ctx.findCall("/api/experiments", "POST");
    post.settled = true;
    post.reject(new TypeError("network down"));
    await flush();

    assertEq(ctx.app().expId, "OLD", "失败后回到 OLD");
    assertEq(ctx.app().expFrozen, false, "存活页不进入冻结");
    assertEq(ctx.app().timerCount, 2, "旧实验轮询恢复");
    assertEq(ctx.el("error-exp").hidden, false, "显示失败错误");
    // 恢复后立即拉取了旧状态
    const recoverCalls = ctx.calls
      .slice(countBefore)
      .filter((c) => c.path.includes("/OLD/") && !c.settled);
    assert(recoverCalls.length >= 2, "应重新拉取旧实验 status / committed");
    // 放行恢复请求：旧读值回来
    for (const call of recoverCalls) {
      call.settled = true;
      call.resolve({
        status: 200,
        ok: true,
        json: async () =>
          call.path.includes("/status") ? OLD_STATUS() : { committed: 111 },
      });
    }
    await flush();
    assertEq(ctx.el("read-a").textContent, 1110, "旧实验读值恢复显示");
  });

  // 场景 5：404 自动新建，并发刷新只建一次
  await test("当前实验 404：自动新建，并发刷新共用同一个创建请求", async () => {
    const ctx = loadApp("?exp=OLD");
    await flush();
    ctx.settle("/OLD/status", 404, {});
    await flush();
    // refreshStatus 走自动新建：POST /api/experiments 在途
    const posts = ctx.calls.filter((c) => c.method === "POST" && c.path === "/api/experiments");
    assertEq(posts.length, 1, "404 后只发起一个新建请求");

    // init 在 refreshStatus（自动新建）之后不会再走 refreshCommitted，
    // 这里额外模拟一轮 tick 内两个轮询同时 404 的并发：先放行到 NEW，
    // 再 tick 两轮，两条 404 共享 creatingPromise。
    ctx.settle("/api/experiments", 201, { id: "NEW" }, "POST");
    await flush();
    // NEW 的首次 status 尚未放行；模拟创建收尾期间多个 404 回调
    ctx.tickTimers(1);
    await flush();
    const posts2 = ctx.calls.filter((c) => c.method === "POST" && c.path === "/api/experiments");
    assertEq(posts2.length, 1, "并发刷新不得重复新建");

    // 放行 NEW 收尾
    ctx.settle("/NEW/status", 200, NEW_STATUS());
    await flush();
    ctx.settle("/NEW/committed", 200, { committed: 222 });
    await flush();
    assertEq(ctx.app().expId, "NEW", "自动新建后切到 NEW");
    assertEq(ctx.app().timerCount, 2, "轮询启动");

    // NEW 上一次轮询若再遇 404，仍会自动新建（语义保留）
    const before = ctx.calls.length;
    ctx.tickTimers(1);
    await flush();
    const stale = ctx.calls
      .slice(before)
      .find((c) => c.path.includes("/NEW/status") && !c.settled);
    assert(stale, "新轮询已发起");
    stale.settled = true;
    stale.resolve({ status: 404, ok: false, json: async () => ({}) });
    await flush();
    const posts3 = ctx.calls.filter((c) => c.method === "POST" && c.path === "/api/experiments");
    assertEq(posts3.length, 2, "新实验 404 仍自动再建一个（规则保留）");
  });

  // 场景 6：410 冻结，不自动新建
  await test("410：冻结且不自动新建，迟到响应也不恢复", async () => {
    const ctx = loadApp("?exp=OLD");
    await flush();
    ctx.settle("/OLD/status", 410, {});
    await flush();
    assertEq(ctx.app().expFrozen, true, "410 冻结");
    const posts = ctx.calls.filter((c) => c.method === "POST" && c.path === "/api/experiments");
    assertEq(posts.length, 0, "410 不得自动新建");
    assertEq(ctx.app().timerCount, 0, "轮询停止");
    ctx.tickTimers(2);
    await flush();
    assertEq(
      ctx.calls.filter((c) => c.path.includes("/OLD/") && !c.settled).length,
      0,
      "冻结后 tick 不得再发旧实验请求"
    );
  });

  console.log(`\n${passed} 通过，${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
