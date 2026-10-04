"use strict";

let expId = null;
// expGen：每次新建 / 冻结实验自增，用于作废在途（迟到）响应，
// 使旧实验的迟到响应不可能恢复旧展示。从 1 开始，init 的首次加载即第 1 代。
let expGen = 1;
// expFrozen：当前实验已删除，旧实验操作全部禁用，轮询停止；
// 只有「新建实验」可以解除。
let expFrozen = false;
// creating：「新建实验」请求进行中。期间暂停旧轮询、禁用一切旧实验操作
// 入口（定时器已清除，creating 再拦下已入队的迟到回调）；成功后只为新 ID
// 启用控件与轮询，失败则按创建前状态回退（冻结页仍冻结、存活页恢复轮询）。
let creating = false;
let statusTimer = null;
let committedTimer = null;
// 404（服务端重启）后多个刷新可能同时到达：用单一在途 Promise 去重，
// 保证同一时刻只会新建一个实验
let creatingPromise = null;
const lastRender = { a: "", b: "" };

const $ = (id) => document.getElementById(id);

// 实验删除开始后（或本次运行中已删除 ID 再次访问）：410，不自动新建
class ExpDeleted extends Error {}
// 未知实验（如服务端重启）：404，沿用旧语义自动新建
class ExpNotFound extends Error {}

async function fetchJson(path, options) {
  const resp = await fetch(path, options);
  if (resp.status === 410) {
    throw new ExpDeleted();
  }
  if (resp.status === 404) {
    throw new ExpNotFound();
  }
  if (!resp.ok) {
    throw new Error("HTTP " + resp.status);
  }
  return resp.json();
}

function stopPolling() {
  // 清除两组轮询定时器。注意 clearInterval 不会撤销已经入队、即将执行的
  // 回调，因此各回调入口还要再检查 creating / expFrozen。
  if (statusTimer !== null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (committedTimer !== null) {
    clearInterval(committedTimer);
    committedTimer = null;
  }
}

function freezeExperiment(reason) {
  // 删除成功或收到 410：停止轮询并禁用全部旧实验操作。幂等。
  if (expFrozen) return;
  expFrozen = true;
  expGen++; // 作废一切在途响应，迟到响应不再渲染 / 不再恢复按钮
  stopPolling();
  setBusy("a", true);
  setBusy("b", true);
  setCheckpointBusy(true);
  $("refresh-committed").disabled = true;
  $("delete-exp").disabled = true;
  $("panel-a").classList.add("exp-frozen");
  $("panel-b").classList.add("exp-frozen");
  $("checkpoint").classList.add("exp-frozen");
  const note = $("deleted-note");
  note.textContent = reason;
  note.hidden = false;
}

function newExperiment() {
  // 去重：并发的自动新建（404）共用同一个 Promise；手动点击同样复用
  if (creatingPromise) return creatingPromise;
  creatingPromise = createExperiment().finally(() => {
    creatingPromise = null;
  });
  return creatingPromise;
}

async function createExperiment() {
  const wasFrozen = expFrozen;
  const oldId = expId;
  const frozenNote = wasFrozen ? $("deleted-note").textContent : "";
  const gen = ++expGen;
  // 创建期间：暂停旧实验轮询（creating 同时拦下已入队的迟到回调），
  // 旧实验的操作入口全部保持禁用，创建成功前没有任何请求可以发到旧 ID。
  creating = true;
  stopPolling();
  // 解除旧实验冻结状态；创建请求完成前先保持控件禁用，
  // 避免在途点击把操作发到旧 expId。
  expFrozen = false;
  $("deleted-note").hidden = true;
  $("panel-a").classList.remove("exp-frozen");
  $("panel-b").classList.remove("exp-frozen");
  $("checkpoint").classList.remove("exp-frozen");
  setBusy("a", true);
  setBusy("b", true);
  setCheckpointBusy(true);
  $("refresh-committed").disabled = true;
  $("delete-exp").disabled = true;
  $("exp-id").textContent = "…";
  $("committed").textContent = "…";

  const failCreate = (message) => {
    if (gen !== expGen) return; // 期间又触发了新建 / 冻结
    creating = false;
    showError("exp", { name: null, code: null, message: "新建实验失败：" + message });
    if (wasFrozen) {
      // 从已删除页面发起的新建失败：旧操作仍禁用、轮询停止，
      // 保持冻结页面，等待手动重试。
      $("exp-id").textContent = oldId;
      $("committed").textContent = "—";
      freezeExperiment(frozenNote);
    } else {
      // 存活页面创建失败：恢复旧实验控件与轮询，错误显示在顶部。
      if (oldId) {
        expId = oldId;
        history.replaceState(null, "", "?exp=" + expId);
      } else {
        history.replaceState(null, "", location.pathname);
      }
      $("exp-id").textContent = expId || "…";
      $("committed").textContent = "—";
      setBusy("a", false);
      setBusy("b", false);
      setCheckpointBusy(false);
      $("refresh-committed").disabled = false;
      $("delete-exp").disabled = false;
      // 立即拉一次旧实验状态，随后恢复轮询
      if (oldId) {
        refreshStatus(gen).catch(() => {});
        refreshCommitted(gen).catch(() => {});
        startPolling();
      }
    }
  };

  let data;
  try {
    const resp = await fetch("/api/experiments", { method: "POST" });
    if (!resp.ok) {
      throw new Error("HTTP " + resp.status);
    }
    data = await resp.json();
  } catch (e) {
    failCreate(e.message);
    return;
  }
  if (gen !== expGen) return; // 期间又触发了新建 / 冻结
  if (!data || !data.id) {
    failCreate("响应缺少实验 ID");
    return;
  }

  // 创建成功：从此刻起一切只围绕新 ID。creating 先复位，旧 ID 的迟到响应
  // 因 gen 不匹配早已全部作废，不可能再影响下面的渲染 / 轮询。
  creating = false;
  expId = data.id;
  history.replaceState(null, "", "?exp=" + expId);
  $("exp-id").textContent = expId;
  for (const side of ["a", "b"]) {
    lastRender[side] = "";
    $(`tx-${side}`).textContent = "…";
    $(`dot-${side}`).classList.remove("on");
    $(`read-${side}`).textContent = "—";
    $(`log-${side}`).innerHTML = "";
    clearError(side);
  }
  $("ckpt-result").textContent = "尚未执行过检查点";
  $("ckpt-result").classList.remove("busy");
  $("log-ckpt").innerHTML = "";
  clearError("ckpt");
  clearError("exp");

  setBusy("a", false);
  setBusy("b", false);
  setCheckpointBusy(false);
  $("refresh-committed").disabled = false;
  $("delete-exp").disabled = false;

  // 新建后的首次刷新绝不允许再触发自动新建：否则 404 会递归 newExperiment，
  // 令刚建好的实验被孤立；这里 404 当作瞬时错误，等待下一轮轮询恢复。
  await refreshStatus(gen, { allowAutoCreate: false });
  if (gen !== expGen || expFrozen) return;
  await refreshCommitted(gen, { allowAutoCreate: false });
  if (gen !== expGen || expFrozen) return;
  startPolling();
}

function startPolling() {
  // 先清理旧定时器，因此重复调用也只会保留一组轮询
  if (statusTimer !== null) clearInterval(statusTimer);
  if (committedTimer !== null) clearInterval(committedTimer);
  // 状态轮询只返回服务端内存状态，不执行任何 SELECT，不会提前建立快照
  statusTimer = setInterval(() => {
    const gen = expGen;
    if (creating || expFrozen) return;
    refreshStatus(gen).catch(() => {});
  }, 2000);
  committedTimer = setInterval(() => {
    const gen = expGen;
    if (creating || expFrozen) return;
    refreshCommitted(gen).catch(() => {});
  }, 2000);
}

async function refreshStatus(gen, opts = {}) {
  const allowAutoCreate = opts.allowAutoCreate !== false;
  if (!expId || creating || expFrozen) return;
  try {
    const data = await fetchJson(`/api/experiments/${expId}/status`);
    if (gen !== expGen || expFrozen) return;
    renderPanel("a", data.a);
    renderPanel("b", data.b);
    renderCheckpoint(data.checkpoint);
  } catch (e) {
    if (e instanceof ExpDeleted) {
      if (gen === expGen) {
        freezeExperiment(`实验 ${expId} 已删除（410）：轮询已停止，旧实验操作已禁用，可点击「新建实验」继续。`);
      }
      return;
    }
    if (e instanceof ExpNotFound) {
      // 服务端重启后旧实验已不存在：自动新建一个（仅处理当前这一代）
      if (allowAutoCreate && gen === expGen && !expFrozen) {
        await newExperiment();
      }
      return;
    }
    // 其他瞬时错误忽略，下一轮轮询会恢复
  }
}

async function refreshCommitted(gen, opts = {}) {
  const allowAutoCreate = opts.allowAutoCreate !== false;
  if (!expId || creating || expFrozen) return;
  try {
    const data = await fetchJson(`/api/experiments/${expId}/committed`);
    if (gen !== expGen || expFrozen) return;
    $("committed").textContent = data.committed;
  } catch (e) {
    if (e instanceof ExpDeleted) {
      if (gen === expGen) {
        freezeExperiment(`实验 ${expId} 已删除（410）：轮询已停止，旧实验操作已禁用，可点击「新建实验」继续。`);
      }
      return;
    }
    if (e instanceof ExpNotFound) {
      // 404（服务端重启）：与状态刷新共用同一个去重 Promise 自动新建
      if (allowAutoCreate && gen === expGen && !expFrozen) {
        await newExperiment();
      }
      return;
    }
    // 其他瞬时错误忽略，下一轮轮询会恢复
  }
}

function renderPanel(side, state) {
  const key = JSON.stringify(state);
  if (lastRender[side] === key) return;
  lastRender[side] = key;

  const inTx = state.in_transaction;
  $("tx-" + side).textContent = inTx ? "已开启" : "未开启";
  const dot = $("dot-" + side);
  dot.classList.toggle("on", inTx);
  dot.title = inTx ? "事务已开启" : "事务未开启";
  $("read-" + side).textContent = state.last_read === null ? "—" : state.last_read;

  const logEl = $("log-" + side);
  logEl.innerHTML = "";
  for (const entry of state.log) {
    const li = document.createElement("li");
    li.textContent = entry;
    if (entry.includes("→ 失败") || entry.includes("→ 拒绝")) {
      li.classList.add("log-error");
    }
    logEl.appendChild(li);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function renderCheckpoint(state) {
  // 只渲染服务端内存中的最近结果缓存：轮询本身不触发检查点
  const resultEl = $("ckpt-result");
  const last = state && state.last;
  if (!last) {
    resultEl.textContent = "尚未执行过检查点";
    resultEl.classList.remove("busy");
  } else {
    resultEl.textContent =
      `最近一次 ${last.mode}：busy=${last.busy}，` +
      `WAL 总帧数=${last.log_frames}，已回写帧数=${last.checkpointed}，` +
      `WAL 文件大小=${last.wal_size} 字节`;
    resultEl.classList.toggle("busy", last.busy === 1);
  }

  const logEl = $("log-ckpt");
  logEl.innerHTML = "";
  for (const entry of (state && state.log) || []) {
    const li = document.createElement("li");
    li.textContent = entry;
    if (entry.includes("失败") || entry.includes("busy=1")) {
      li.classList.add("log-error");
    }
    logEl.appendChild(li);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function setBusy(side, busy) {
  // 只禁用本栏的按钮与输入框，另一栏不受影响
  for (const el of document.querySelectorAll(
    `#panel-${side} button, #panel-${side} input`
  )) {
    el.disabled = busy;
  }
}

function showError(side, error) {
  const box = $("error-" + side);
  box.textContent = error.name
    ? `${error.name}（错误码 ${error.code}）：${error.message}`
    : error.message;
  box.hidden = false;
}

function clearError(side) {
  $("error-" + side).hidden = true;
}

async function doOp(side, op) {
  if (creating || expFrozen) return;
  const body = { op };
  if (op === "add") {
    const raw = $(`add-input-${side}`).value.trim();
    if (!/^[+-]?\d+$/.test(raw)) {
      showError(side, { name: null, code: null, message: "请输入一个整数" });
      return;
    }
    // 大整数以十进制字符串传输避免精度丢失；安全整数范围内仍发送数字
    const big = BigInt(raw);
    body.value =
      big >= BigInt(Number.MIN_SAFE_INTEGER) &&
      big <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(big)
        : big.toString();
  }
  const gen = expGen;
  setBusy(side, true);
  clearError(side);
  try {
    const data = await fetchJson(`/api/experiments/${expId}/conn/${side}/op`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (gen !== expGen) return;
    renderPanel(side, data.state);
    if (!data.ok && data.error) {
      showError(side, data.error);
    }
    refreshCommitted(gen);
  } catch (e) {
    if (e instanceof ExpDeleted) {
      if (gen === expGen) {
        freezeExperiment(`实验 ${expId} 已删除（410）：操作未执行，旧实验操作已禁用，可点击「新建实验」继续。`);
      }
      return;
    }
    if (e instanceof ExpNotFound) {
      if (gen === expGen && !expFrozen) {
        await newExperiment();
      }
      return;
    }
    if (gen === expGen && !expFrozen) {
      showError(side, { name: null, code: null, message: "请求失败：" + e.message });
    }
  } finally {
    // 冻结 / 已切换到新实验后，迟到响应不得改动当前按钮状态
    if (gen === expGen && !expFrozen) {
      setBusy(side, false);
    }
  }
}

function bindPanel(side) {
  for (const btn of document.querySelectorAll(`#panel-${side} button[data-op]`)) {
    btn.addEventListener("click", () => doOp(side, btn.dataset.op));
  }
}

function setCheckpointBusy(busy) {
  // 检查点请求进行中只禁用检查点按钮，甲、乙两栏照常可用
  $("ckpt-passive").disabled = busy;
  $("ckpt-truncate").disabled = busy;
}

async function doCheckpoint(mode) {
  if (creating || expFrozen) return;
  const gen = expGen;
  setCheckpointBusy(true);
  clearError("ckpt");
  try {
    const data = await fetchJson(`/api/experiments/${expId}/checkpoint/${mode}`, {
      method: "POST",
    });
    if (gen !== expGen) return;
    renderCheckpoint(data.state);
    if (!data.ok && data.error) {
      showError("ckpt", data.error);
    }
  } catch (e) {
    if (e instanceof ExpDeleted) {
      if (gen === expGen) {
        freezeExperiment(`实验 ${expId} 已删除（410）：检查点未执行，旧实验操作已禁用，可点击「新建实验」继续。`);
      }
      return;
    }
    if (e instanceof ExpNotFound) {
      if (gen === expGen && !expFrozen) {
        await newExperiment();
      }
      return;
    }
    if (gen === expGen && !expFrozen) {
      showError("ckpt", { name: null, code: null, message: "请求失败：" + e.message });
    }
  } finally {
    if (gen === expGen && !expFrozen) {
      setCheckpointBusy(false);
    }
  }
}

async function deleteCurrentExperiment() {
  if (!expId || creating || expFrozen) return;
  const id = expId;
  const ok = window.confirm(
    `确认删除当前实验 ${id} ？\n\n` +
    "将等待进行中的请求完成，随后回滚未提交事务、关闭全部连接，" +
    "并删除数据库及 WAL、SHM 文件。\n" +
    "删除后本页旧实验操作将被禁用并停止轮询，可随时手动新建实验。"
  );
  if (!ok) return;
  const gen = expGen;
  $("delete-exp").disabled = true;
  clearError("exp");
  try {
    await fetchJson(`/api/experiments/${id}`, { method: "DELETE" });
    if (gen !== expGen) return;
    freezeExperiment(`实验 ${id} 已删除：在途请求已完成，未提交事务已回滚，连接已关闭，数据库与 WAL/SHM 文件已移除。可点击「新建实验」继续。`);
  } catch (e) {
    if (e instanceof ExpDeleted) {
      if (gen === expGen) {
        freezeExperiment(`实验 ${id} 已删除（410）：旧实验操作已禁用，可点击「新建实验」继续。`);
      }
      return;
    }
    if (e instanceof ExpNotFound) {
      if (gen === expGen && !expFrozen) {
        await newExperiment();
      }
      return;
    }
    if (gen === expGen && !expFrozen) {
      $("delete-exp").disabled = false;
      showError("exp", { name: null, code: null, message: "删除失败：" + e.message });
    }
  }
}

async function init() {
  bindPanel("a");
  bindPanel("b");
  $("new-exp").addEventListener("click", () => {
    newExperiment().catch(() => {});
  });
  $("delete-exp").addEventListener("click", () => {
    deleteCurrentExperiment().catch(() => {});
  });
  $("refresh-committed").addEventListener("click", () => {
    if (creating || expFrozen) return;
    refreshCommitted(expGen).catch(() => {});
  });
  $("ckpt-passive").addEventListener("click", () => {
    doCheckpoint("PASSIVE").catch(() => {});
  });
  $("ckpt-truncate").addEventListener("click", () => {
    doCheckpoint("TRUNCATE").catch(() => {});
  });

  const params = new URLSearchParams(location.search);
  const existing = params.get("exp");
  if (existing) {
    const gen = expGen;
    expId = existing;
    $("exp-id").textContent = existing;
    // 404 时 refreshStatus 会自动新建（expId 改变并已自行启动轮询）；
    // 410 时会冻结视图。这两种情况都不再执行后面的初始化。
    await refreshStatus(gen);
    if (expFrozen || expId !== existing) return;
    await refreshCommitted(gen);
    if (expFrozen || expId !== existing) return;
    startPolling();
  } else {
    await newExperiment();
  }
}

init();
