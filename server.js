import express from "express";
import { nanoid } from "nanoid";
import { EventEmitter } from "node:events";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { runSeatTask, previewSeatMatch, fetchSeatMenu, TARGET } from "./src/seatBot.js";
import { authenticateUser, bindStudentId, createUser, deleteUser, getUser, listUsers } from "./src/authStore.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const tasks = new Map();
const bus = new EventEmitter();
const serverMode = {
  nodeEnv: process.env.NODE_ENV || "development",
  forceHeadless: /^(1|true|yes|on)$/i.test(String(process.env.FORCE_HEADLESS || "")),
};
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const adminUsername = process.env.ADMIN_USERNAME || "";
const adminPassword = process.env.ADMIN_PASSWORD || "";

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function signSession(username) {
  return createHmac("sha256", sessionSecret).update(username).digest("hex");
}

function signAdminSession(username) {
  return createHmac("sha256", sessionSecret).update(`admin:${username}:${adminPassword}`).digest("hex");
}

function constantTimeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie).seat_session;
  if (!raw) return null;
  const [username, signature] = raw.split(".");
  if (!username || !signature) return null;
  const expected = signSession(username);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return getUser(username);
}

function setSessionCookie(res, username) {
  const value = `${username}.${signSession(username)}`;
  res.setHeader("Set-Cookie", `seat_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "seat_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function readAdminSession(req) {
  const raw = parseCookies(req.headers.cookie).admin_session;
  if (!raw) return null;
  const [encodedUsername, signature] = raw.split(".");
  if (!encodedUsername || !signature) return null;
  let username = "";
  try {
    username = Buffer.from(encodedUsername, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = signAdminSession(username);
  if (!constantTimeEqual(signature, expected)) return null;
  if (!constantTimeEqual(username, adminUsername)) return null;
  return { username };
}

function setAdminSessionCookie(res, username) {
  const encodedUsername = Buffer.from(username, "utf8").toString("base64url");
  const value = `${encodedUsername}.${signAdminSession(username)}`;
  res.setHeader("Set-Cookie", `admin_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
}

function clearAdminSessionCookie(res) {
  res.setHeader("Set-Cookie", "admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function requireAuth(req, res, next) {
  const user = readSession(req);
  if (!user) {
    res.status(401).json({ ok: false, message: "请先登录系统账号" });
    return;
  }
  req.user = user;
  next();
}

function currentUser(req) {
  return req.user || readSession(req);
}

function requireAdmin(req, res, next) {
  const admin = readAdminSession(req);
  if (!adminUsername || !adminPassword) {
    res.status(503).json({ ok: false, message: "未配置管理员账号密码" });
    return;
  }
  if (!admin) {
    res.status(401).json({ ok: false, message: "请先登录管理员账号" });
    return;
  }
  req.admin = admin;
  next();
}

function randomPassword() {
  return randomBytes(9).toString("base64url");
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function addLog(task, level, message) {
  const entry = { at: nowText(), level, message };
  task.logs.push(entry);
  if (task.logs.length > 300) task.logs.shift();
  bus.emit("log", { taskId: task.id, entry });
}

function toDate(dateValue, timeValue) {
  const value = `${dateValue}T${timeValue}:00`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toDateOnly(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function minutesBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

function daysBetween(a, b) {
  const start = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isClockTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeSeatCandidates(body) {
  const values = Array.isArray(body?.seatCandidates) ? body.seatCandidates : [body?.seatNo];
  if (body?.seatNo && !values.includes(body.seatNo)) values.unshift(body.seatNo);

  const seen = new Set();
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.replace(/\s+/g, "").toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function nextRunAt(startTime) {
  const [hours, minutes] = startTime.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  if (date.getTime() <= Date.now() - 5000) {
    date.setDate(date.getDate() + 1);
  }
  return date;
}

function scheduleTask(task, startAt = nextRunAt(task.form.startTime)) {
  if (task.cancelled) return;
  if (task.timer) clearTimeout(task.timer);
  task.status = "scheduled";
  task.scheduledAt = startAt.toISOString();
  const delay = Math.max(0, startAt.getTime() - Date.now());
  task.timer = setTimeout(() => executeTask(task, startAt), delay);
}

function materializeRunForm(task, runAt = new Date()) {
  const baseDate = new Date(runAt.getFullYear(), runAt.getMonth(), runAt.getDate());
  return {
    ...task.form,
    segments: task.form.segments.map((segment) => ({
      date: dateInputValue(addDays(baseDate, segment.dayOffset ?? 0)),
      begin: segment.begin,
      end: segment.end,
    })),
  };
}

function validatePayload(body) {
  const errors = [];
  const seatCandidates = normalizeSeatCandidates(body);
  if (!body || typeof body !== "object") errors.push("请求内容无效");
  if (!body.password?.trim()) errors.push("请输入统一认证密码");
  if (!body.startTime) errors.push("请选择开始抢座时间");
  if (body.startTime && !isClockTime(body.startTime)) errors.push("开始抢座时间无效，请使用 HH:mm");
  if (!seatCandidates.length) errors.push("请输入座位号");
  if (!Array.isArray(body.segments) || body.segments.length === 0) errors.push("至少添加一个预约时间段");
  if (Array.isArray(body.segments)) {
    body.segments.forEach((segment, index) => {
      const prefix = `第 ${index + 1} 段`;
      const segmentDate = toDateOnly(segment.date);
      const begin = toDate(segment.date, segment.begin);
      const end = toDate(segment.date, segment.end);
      if (!segmentDate || !begin || !end) {
        errors.push(`${prefix} 时间无效`);
        return;
      }
      const minutes = minutesBetween(begin, end);
      if (minutes <= 0) errors.push(`${prefix} 结束时间必须晚于开始时间`);
      if (minutes > 180) errors.push(`${prefix} 超过 3 小时限制`);
    });
  }
  return errors;
}

function validateSeatPreviewPayload(body) {
  const errors = [];
  const seatCandidates = normalizeSeatCandidates(body);
  if (!body || typeof body !== "object") errors.push("请求内容无效");
  if (!body.password?.trim()) errors.push("请输入统一认证密码");
  if (!seatCandidates.length) errors.push("请输入座位号");
  if (!body.date || Number.isNaN(new Date(`${body.date}T00:00:00`).getTime())) errors.push("请选择有效日期");
  return errors;
}

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    scheduledAt: task.scheduledAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    runCount: task.runCount,
    lastRunOk: task.lastRunOk,
    recurring: task.recurring,
    target: task.target,
    form: {
      account: task.form.account,
      seatNo: task.form.seatNo,
      seatCandidates: task.form.seatCandidates,
      roomId: task.form.roomId,
      mode: task.form.mode,
      visibleBrowser: task.form.visibleBrowser,
      startTime: task.form.startTime,
      segments: task.form.segments,
    },
    logs: task.logs,
    result: task.result,
  };
}

async function executeTask(task, runAt = new Date()) {
  if (task.cancelled) return;
  task.status = "running";
  task.timer = null;
  task.startedAt = new Date().toISOString();
  addLog(task, "info", "到达设定时间，开始执行预约任务");
  try {
    const runForm = materializeRunForm(task, runAt);
    addLog(task, "info", `本次预约日期：${runForm.segments.map((segment) => segment.date).join("、")}`);
    task.result = await runSeatTask(runForm, (level, message) => addLog(task, level, message));
    task.lastRunOk = Boolean(task.result.ok);
    task.runCount += 1;
    addLog(task, task.result.ok ? "success" : "error", task.result.message);
  } catch (error) {
    task.result = { ok: false, message: error.message };
    task.lastRunOk = false;
    task.runCount += 1;
    addLog(task, "error", error.message);
  } finally {
    task.finishedAt = new Date().toISOString();
    if (!task.cancelled && task.recurring) {
      const nextAt = nextRunAt(task.form.startTime);
      scheduleTask(task, nextAt);
      addLog(task, "info", `已安排下一次每日执行：${nextAt.toLocaleString("zh-CN", { hour12: false })}`);
    } else if (!task.cancelled) {
      task.status = task.result?.ok ? "done" : "failed";
    }
    bus.emit("task", publicTask(task));
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, target: TARGET.baseUrl, mode: serverMode, time: new Date().toISOString() });
});

app.get(["/admin", "/admin/"], (_req, res) => {
  res.sendFile(resolve("public/admin.html"));
});

app.get("/api/auth/me", (req, res) => {
  res.json({ ok: true, user: readSession(req) });
});

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const user = authenticateUser(username, password);
  if (!user) {
    res.status(401).json({ ok: false, message: "系统账号或密码错误" });
    return;
  }
  setSessionCookie(res, user.username);
  res.json({ ok: true, user });
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/auth/bind-student", requireAuth, (req, res) => {
  try {
    const user = bindStudentId(req.user.username, req.body?.studentId);
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.get("/api/admin/me", (req, res) => {
  if (!adminUsername || !adminPassword) {
    res.status(503).json({ ok: false, message: "未配置管理员账号密码", admin: null });
    return;
  }
  res.json({ ok: true, admin: readAdminSession(req) });
});

app.post("/api/admin/login", (req, res) => {
  if (!adminUsername || !adminPassword) {
    res.status(503).json({ ok: false, message: "未配置管理员账号密码" });
    return;
  }
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!constantTimeEqual(username, adminUsername) || !constantTimeEqual(password, adminPassword)) {
    res.status(401).json({ ok: false, message: "管理员账号或密码错误" });
    return;
  }
  setAdminSessionCookie(res, adminUsername);
  res.json({ ok: true, admin: { username: adminUsername } });
});

app.post("/api/admin/logout", (_req, res) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  res.json({ ok: true, users: listUsers() });
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  try {
    const username = req.body?.username;
    const password = req.body?.password || randomPassword();
    const user = createUser(username, password);
    res.json({ ok: true, user: { ...user, initialPassword: password } });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.delete("/api/admin/users/:username", requireAdmin, (req, res) => {
  try {
    const username = req.params.username;
    for (const task of tasks.values()) {
      if (task.owner !== username) continue;
      if (task.timer) clearTimeout(task.timer);
      task.cancelled = true;
      tasks.delete(task.id);
      bus.emit("task-deleted", { taskId: task.id, owner: task.owner });
    }
    deleteUser(username);
    res.json({ ok: true, username });
  } catch (error) {
    res.status(404).json({ ok: false, message: error.message });
  }
});

app.get("/api/seat-menu", requireAuth, async (_req, res) => {
  try {
    const menu = await fetchSeatMenu();
    res.json({ ok: true, menu });
  } catch (error) {
    res.status(502).json({ ok: false, message: error.message });
  }
});

app.get("/api/tasks", requireAuth, (req, res) => {
  res.json({
    tasks: [...tasks.values()]
      .filter((task) => task.owner === req.user.username)
      .map(publicTask)
      .reverse(),
  });
});

app.post("/api/tasks", requireAuth, (req, res) => {
  const user = currentUser(req);
  if (!user.boundStudentId) {
    res.status(400).json({ ok: false, errors: ["请先绑定学号"] });
    return;
  }
  const startAt = req.body?.startTime && isClockTime(req.body.startTime) ? nextRunAt(req.body.startTime) : null;
  const errors = validatePayload(req.body);
  if (errors.length) {
    res.status(400).json({ ok: false, errors });
    return;
  }

  const runDate = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate());
  const seatCandidates = normalizeSeatCandidates(req.body);
  const form = {
    account: user.boundStudentId,
    password: req.body.password,
    startTime: req.body.startTime,
    seatNo: seatCandidates[0],
    seatCandidates,
    roomId: req.body.roomId ? String(req.body.roomId) : "",
    mode: req.body.mode === "api" ? "api" : "browser",
    visibleBrowser: req.body.visibleBrowser !== false,
    segments: req.body.segments.map((segment) => {
      const segmentDate = toDateOnly(segment.date);
      return {
        date: segment.date,
        dayOffset: daysBetween(runDate, segmentDate),
        begin: segment.begin,
        end: segment.end,
      };
    }),
  };

  const task = {
    id: nanoid(10),
    status: "scheduled",
    createdAt: new Date().toISOString(),
    scheduledAt: startAt.toISOString(),
    startedAt: null,
    finishedAt: null,
    runCount: 0,
    lastRunOk: null,
    recurring: true,
    cancelled: false,
    owner: user.username,
    target: TARGET,
    form,
    logs: [],
    result: null,
    timer: null,
  };

  tasks.set(task.id, task);
  scheduleTask(task, startAt);
  addLog(task, "info", `每日任务已创建，下一次将在 ${startAt.toLocaleString("zh-CN", { hour12: false })} 开始`);
  addLog(task, "info", `每日开始抢座时间：${form.startTime}`);
  addLog(task, "info", "预约日期规则：按页面选择的日期提交，每日任务按该日期与开始抢座日期的相对天数滚动");
  addLog(task, "info", `候选座位 ${form.seatCandidates.join("、")}，共 ${form.segments.length} 个时间段`);
  res.json({ ok: true, task: publicTask(task) });
});

app.post("/api/seat-preview", requireAuth, async (req, res) => {
  const user = currentUser(req);
  if (!user.boundStudentId) {
    res.status(400).json({ ok: false, errors: ["请先绑定学号"] });
    return;
  }
  const errors = validateSeatPreviewPayload(req.body);
  if (errors.length) {
    res.status(400).json({ ok: false, errors });
    return;
  }

  const logs = [];
  try {
    const previewDate = toDateOnly(req.body.date);
    const seatCandidates = normalizeSeatCandidates(req.body);
    const result = await previewSeatMatch(
      {
        account: user.boundStudentId,
        password: req.body.password,
        seatNo: seatCandidates[0],
        seatCandidates,
        roomId: req.body.roomId ? String(req.body.roomId) : "",
        date: dateInputValue(previewDate),
        visibleBrowser: req.body.visibleBrowser !== false,
      },
      (level, message) => logs.push({ at: nowText(), level, message }),
    );
    res.json({ ok: true, result, logs });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message, logs });
  }
});

app.post("/api/tasks/:id/run-now", requireAuth, (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ ok: false, message: "任务不存在" });
    return;
  }
  if (task.owner !== req.user.username) {
    res.status(403).json({ ok: false, message: "无权操作该任务" });
    return;
  }
  if (!["scheduled", "failed"].includes(task.status)) {
    res.status(409).json({ ok: false, message: "当前任务状态不能立即执行" });
    return;
  }
  if (task.timer) clearTimeout(task.timer);
  task.timer = null;
  const runAt = task.scheduledAt ? new Date(task.scheduledAt) : new Date();
  setTimeout(() => executeTask(task, runAt), 50);
  res.json({ ok: true, task: publicTask(task) });
});

app.delete("/api/tasks/:id", requireAuth, (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ ok: false, message: "任务不存在" });
    return;
  }
  if (task.owner !== req.user.username) {
    res.status(403).json({ ok: false, message: "无权操作该任务" });
    return;
  }
  if (task.timer) clearTimeout(task.timer);
  task.timer = null;
  task.cancelled = true;
  tasks.delete(task.id);
  bus.emit("task-deleted", { taskId: task.id, owner: task.owner });
  res.json({ ok: true, taskId: task.id });
});

app.get("/api/events", requireAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", at: nowText() })}\n\n`);

  const canReadTask = (taskId) => tasks.get(taskId)?.owner === req.user.username;
  const onLog = (payload) => {
    if (canReadTask(payload.taskId)) res.write(`data: ${JSON.stringify({ type: "log", ...payload })}\n\n`);
  };
  const onTask = (task) => {
    if (canReadTask(task.id)) res.write(`data: ${JSON.stringify({ type: "task", task })}\n\n`);
  };
  const onTaskDeleted = (payload) => {
    if (payload.owner === req.user.username) res.write(`data: ${JSON.stringify({ type: "task-deleted", taskId: payload.taskId })}\n\n`);
  };
  bus.on("log", onLog);
  bus.on("task", onTask);
  bus.on("task-deleted", onTaskDeleted);
  req.on("close", () => {
    bus.off("log", onLog);
    bus.off("task", onTask);
    bus.off("task-deleted", onTaskDeleted);
  });
});

app.listen(port, () => {
  console.log(`Library seat reserver: http://localhost:${port}`);
});
