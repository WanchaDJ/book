const form = document.querySelector("#taskForm");
const segmentsEl = document.querySelector("#segments");
const template = document.querySelector("#segmentTemplate");
const taskListEl = document.querySelector("#taskList");
const logBox = document.querySelector("#logBox");
const statusEl = document.querySelector("#serverStatus");
const roomSelect = document.querySelector("#roomId");
const loginForm = document.querySelector("#loginForm");
const bindForm = document.querySelector("#bindForm");
const userBar = document.querySelector("#userBar");
const authStatus = document.querySelector("#authStatus");
const userInfoText = document.querySelector("#userInfoText");
const logoutButton = document.querySelector("#logoutButton");

let tasks = [];
let lastDefaultSegmentDate = "";
let currentUser = null;
let events = null;

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateInput(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isClockTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || "");
}

function nextRunDate(startTime = form.startTime.value) {
  const date = new Date();
  if (isClockTime(startTime)) {
    const [hours, minutes] = startTime.split(":").map(Number);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= Date.now() - 5000) date.setDate(date.getDate() + 1);
  }
  return date;
}

function defaultSegmentDate() {
  return dateInput(addDays(nextRunDate(), 1));
}

function addMinutesToTime(timeValue, minutesToAdd) {
  if (!isClockTime(timeValue)) return "";
  const [hours, minutes] = timeValue.split(":").map(Number);
  const totalMinutes = hours * 60 + minutes + minutesToAdd;
  const nextHours = Math.floor(totalMinutes / 60) % 24;
  const nextMinutes = totalMinutes % 60;
  return `${pad(nextHours)}:${pad(nextMinutes)}`;
}

function segmentDisplayDate(task, segment) {
  if (typeof segment.dayOffset !== "number" || !task.scheduledAt) return segment.date;
  const scheduledDate = new Date(task.scheduledAt);
  return dateInput(addDays(scheduledDate, segment.dayOffset));
}

function normalizeSeatList(values) {
  const seen = new Set();
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.replace(/\s+/g, "").toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function collectSeatCandidates() {
  return normalizeSeatList([form.seatNo.value, form.seatNoAlt1.value, form.seatNoAlt2.value]);
}

function setControlsEnabled(enabled) {
  for (const element of form.elements) {
    if (element.id !== "account") element.disabled = !enabled;
  }
  document.querySelector("#addSegment").disabled = !enabled;
  document.querySelector("#refreshMenu").disabled = !enabled;
  document.querySelector("#previewSeat").disabled = !enabled;
}

function renderAuth() {
  const loggedIn = Boolean(currentUser);
  const bound = Boolean(currentUser?.boundStudentId);
  authStatus.textContent = loggedIn ? (bound ? "已绑定" : "待绑定") : "未登录";
  loginForm.classList.toggle("hidden", loggedIn);
  bindForm.classList.toggle("hidden", !loggedIn || bound);
  userBar.classList.toggle("hidden", !loggedIn);
  form.account.value = bound ? currentUser.boundStudentId : "";
  setControlsEnabled(bound);

  if (loggedIn) {
    userInfoText.textContent = bound
      ? `系统账号 ${currentUser.username}，绑定学号 ${currentUser.boundStudentId}`
      : `系统账号 ${currentUser.username}，请先绑定学号`;
  }
}

function addLog(entry) {
  const div = document.createElement("div");
  div.className = `log-entry ${entry.level || ""}`;
  div.textContent = `[${entry.at || new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${entry.message}`;
  logBox.append(div);
  logBox.scrollTop = logBox.scrollHeight;
}

function addSegment(values = {}) {
  const node = template.content.firstElementChild.cloneNode(true);
  const dateField = node.querySelector(".seg-date");
  dateField.value = values.date || defaultSegmentDate();
  dateField.dataset.autoDate = values.date ? "false" : "true";
  dateField.addEventListener("input", () => {
    dateField.dataset.autoDate = "false";
  });
  const beginField = node.querySelector(".seg-begin");
  const endField = node.querySelector(".seg-end");
  beginField.value = values.begin || "08:00";
  endField.value = values.end || addMinutesToTime(beginField.value, 180);
  beginField.addEventListener("input", () => {
    endField.value = addMinutesToTime(beginField.value, 180);
  });
  node.querySelector(".remove-seg").addEventListener("click", () => {
    if (segmentsEl.children.length > 1) node.remove();
  });
  segmentsEl.append(node);
}

function updateDefaultSegmentDates() {
  const nextDefault = defaultSegmentDate();
  for (const input of segmentsEl.querySelectorAll(".seg-date")) {
    if (input.dataset.autoDate === "true" || !input.value || input.value === lastDefaultSegmentDate) {
      input.value = nextDefault;
      input.dataset.autoDate = "true";
    }
  }
  lastDefaultSegmentDate = nextDefault;
}

function collectSegments() {
  return [...segmentsEl.querySelectorAll(".segment-row")].map((row) => ({
    date: row.querySelector(".seg-date").value,
    begin: row.querySelector(".seg-begin").value,
    end: row.querySelector(".seg-end").value,
  }));
}

function minutes(segment) {
  const begin = new Date(`${segment.date}T${segment.begin}:00`);
  const end = new Date(`${segment.date}T${segment.end}:00`);
  return Math.round((end - begin) / 60000);
}

function validateSegments(segments) {
  const errors = [];
  segments.forEach((segment, index) => {
    const diff = minutes(segment);
    if (!Number.isFinite(diff) || diff <= 0) errors.push(`第 ${index + 1} 段结束时间必须晚于开始时间`);
    if (diff > 180) errors.push(`第 ${index + 1} 段超过 3 小时`);
  });
  return errors;
}

function statusText(status) {
  return {
    scheduled: "每日等待中",
    running: "执行中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[status] || status;
}

function renderTasks() {
  if (!tasks.length) {
    taskListEl.innerHTML = `<div class="empty">暂无任务</div>`;
    return;
  }
  taskListEl.innerHTML = tasks
    .map((task) => {
      const segments = task.form.segments.map((s) => `${segmentDisplayDate(task, s)} ${s.begin}-${s.end}`).join("；");
      const scheduledAt = new Date(task.scheduledAt).toLocaleString("zh-CN", { hour12: false });
      const last = task.runCount ? `；已执行 ${task.runCount} 次${task.lastRunOk === false ? "，上次失败" : ""}` : "";
      const seats = task.form.seatCandidates?.length ? task.form.seatCandidates.join(" → ") : task.form.seatNo;
      return `
        <article class="task-card" data-id="${task.id}">
          <header>
            <span>${task.form.seatNo} · ${statusText(task.status)}</span>
            <span>每日 ${task.form.startTime || "--:--"}</span>
          </header>
          <p>下次执行 ${scheduledAt}；账号 ${task.form.account}；候选座位 ${seats}；将预约 ${segments}${last}</p>
          <div class="task-actions">
            <button class="secondary run-now" ${task.status === "running" ? "disabled" : ""}>立即执行</button>
            <button class="trash-task" title="删除任务" aria-label="删除任务">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M8 6V4h8v2" />
                <path d="M6 6l1 15h10l1-15" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

async function loadTasks() {
  if (!currentUser) {
    tasks = [];
    renderTasks();
    return;
  }
  const response = await fetch("/api/tasks");
  if (response.status === 401) {
    await loadCurrentUser();
    return;
  }
  const data = await response.json();
  tasks = data.tasks || [];
  renderTasks();
}

async function loadSeatMenu() {
  if (!currentUser?.boundStudentId) return;
  roomSelect.disabled = true;
  try {
    const response = await fetch("/api/seat-menu");
    const data = await response.json();
    if (!data.ok) throw new Error(data.message);
    const options = [`<option value="">自动识别</option>`];
    for (const floor of data.menu) {
      for (const room of floor.children || []) {
        options.push(
          `<option value="${room.id}">${floor.name} / ${room.name}（余 ${room.remainCount}/${room.totalCount}）</option>`,
        );
      }
    }
    roomSelect.innerHTML = options.join("");
    addLog({ level: "success", message: "阅览区列表已刷新" });
  } catch (error) {
    addLog({ level: "warn", message: `阅览区列表刷新失败：${error.message}` });
  } finally {
    roomSelect.disabled = false;
  }
}

async function createTask(event) {
  event.preventDefault();
  if (!currentUser?.boundStudentId) {
    addLog({ level: "error", message: "请先登录并绑定学号" });
    return;
  }
  const submitButton = form.querySelector(".primary");
  const segments = collectSegments();
  const seatCandidates = collectSeatCandidates();
  const errors = validateSegments(segments);
  if (!seatCandidates.length) errors.push("请输入座位号");
  if (errors.length) {
    errors.forEach((message) => addLog({ level: "error", message }));
    return;
  }

  const payload = {
    password: form.password.value,
    startTime: form.startTime.value,
    seatNo: seatCandidates[0],
    seatCandidates,
    roomId: form.roomId.value,
    mode: new FormData(form).get("mode"),
    visibleBrowser: document.querySelector("#visibleBrowser").checked,
    segments,
  };

  submitButton.disabled = true;
  try {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error((data.errors || [data.message || "创建失败"]).join("；"));
    }
    addLog({ level: "success", message: `任务已创建：${data.task.id}` });
    await loadTasks();
  } catch (error) {
    addLog({ level: "error", message: error.message });
  } finally {
    submitButton.disabled = false;
  }
}

async function previewSeat() {
  if (!currentUser?.boundStudentId) {
    addLog({ level: "error", message: "请先登录并绑定学号" });
    return;
  }
  const button = document.querySelector("#previewSeat");
  const firstSegment = collectSegments()[0];
  const seatCandidates = collectSeatCandidates();
  const payload = {
    password: form.password.value,
    seatNo: seatCandidates[0] || "",
    seatCandidates,
    roomId: form.roomId.value,
    date: firstSegment?.date || defaultSegmentDate(),
    visibleBrowser: document.querySelector("#visibleBrowser").checked,
  };

  if (!payload.password || !payload.seatNo) {
    addLog({ level: "error", message: "请先填写统一认证密码和座位号" });
    return;
  }

  button.disabled = true;
  addLog({ level: "info", message: "开始检查座位匹配，不会提交预约" });
  try {
    const response = await fetch("/api/seat-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    for (const entry of data.logs || []) addLog(entry);
    if (!response.ok || !data.ok) {
      throw new Error((data.errors || [data.message || "检查失败"]).join("；"));
    }
    addLog({ level: "success", message: data.result.message });
  } catch (error) {
    addLog({ level: "error", message: error.message });
  } finally {
    button.disabled = false;
  }
}

async function handleTaskAction(event) {
  const card = event.target.closest(".task-card");
  if (!card) return;
  const id = card.dataset.id;
  if (event.target.classList.contains("run-now")) {
    await fetch(`/api/tasks/${id}/run-now`, { method: "POST" });
    await loadTasks();
  }
  if (event.target.closest(".trash-task")) {
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    await loadTasks();
  }
}

function connectEvents() {
  if (events) events.close();
  if (!currentUser) return;
  events = new EventSource("/api/events");
  events.onopen = () => {
    statusEl.textContent = "已连接";
  };
  events.onerror = () => {
    statusEl.textContent = "重连中";
  };
  events.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "log") addLog(data.entry);
    if (data.type === "task") {
      const index = tasks.findIndex((task) => task.id === data.task.id);
      if (index >= 0) tasks[index] = data.task;
      else tasks.unshift(data.task);
      renderTasks();
    }
    if (data.type === "task-deleted") {
      tasks = tasks.filter((task) => task.id !== data.taskId);
      renderTasks();
    }
  };
}

async function loadCurrentUser() {
  const response = await fetch("/api/auth/me");
  const data = await response.json();
  currentUser = data.user || null;
  renderAuth();
  await loadTasks();
  if (currentUser?.boundStudentId) {
    await loadSeatMenu();
    connectEvents();
  } else if (events) {
    events.close();
    events = null;
  }
}

async function login(event) {
  event.preventDefault();
  const payload = {
    username: document.querySelector("#loginUsername").value,
    password: document.querySelector("#loginPassword").value,
  };
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || "登录失败");
    currentUser = data.user;
    document.querySelector("#loginPassword").value = "";
    renderAuth();
    addLog({ level: "success", message: `系统账号 ${currentUser.username} 已登录` });
    await loadCurrentUser();
  } catch (error) {
    addLog({ level: "error", message: error.message });
  }
}

async function bindStudent(event) {
  event.preventDefault();
  const payload = { studentId: document.querySelector("#boundStudentId").value };
  try {
    const response = await fetch("/api/auth/bind-student", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.message || "绑定失败");
    currentUser = data.user;
    document.querySelector("#boundStudentId").value = "";
    renderAuth();
    addLog({ level: "success", message: `已绑定学号 ${currentUser.boundStudentId}` });
    await loadCurrentUser();
  } catch (error) {
    addLog({ level: "error", message: error.message });
  }
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  currentUser = null;
  tasks = [];
  if (events) events.close();
  events = null;
  renderAuth();
  renderTasks();
  addLog({ level: "warn", message: "已退出系统账号" });
}

function tickClock() {
  document.querySelector("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

document.querySelector("#addSegment").addEventListener("click", () => addSegment());
document.querySelector("#refreshMenu").addEventListener("click", loadSeatMenu);
document.querySelector("#previewSeat").addEventListener("click", previewSeat);
taskListEl.addEventListener("click", handleTaskAction);
form.startTime.addEventListener("input", updateDefaultSegmentDates);
form.addEventListener("submit", createTask);
loginForm.addEventListener("submit", login);
bindForm.addEventListener("submit", bindStudent);
logoutButton.addEventListener("click", logout);

const start = new Date(Date.now() + 5 * 60 * 1000);
form.startTime.value = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
lastDefaultSegmentDate = defaultSegmentDate();
addSegment();
tickClock();
setInterval(tickClock, 1000);
renderAuth();
loadCurrentUser();
