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
const clearLogsButton = document.querySelector("#clearLogs");
const weekdayPicker = document.querySelector("#weekdayPicker");
const controlPanel = document.querySelector(".control-panel");
const taskEditNotice = document.querySelector("#taskEditNotice");
const taskEditText = document.querySelector("#taskEditText");
const cancelTaskEditButton = document.querySelector("#cancelTaskEdit");
const taskSubmitButton = document.querySelector("#taskSubmitButton");
const passwordLabel = document.querySelector("#passwordLabel");

let tasks = [];
let lastDefaultSegmentDate = "";
let currentUser = null;
let events = null;
let taskNameTouched = false;
let editingTaskId = null;
let editingPasswordTouched = false;

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

function collectWeekdays() {
  return [...form.querySelectorAll('input[name="weekdays"]:checked')].map((input) => Number(input.value));
}

function collectSchedule() {
  const scheduleType = new FormData(form).get("scheduleType") === "weekly" ? "weekly" : "daily";
  return {
    scheduleType,
    weekdays: scheduleType === "weekly" ? collectWeekdays() : [],
  };
}

function scheduleLabel(schedule = { type: "daily", weekdays: [] }) {
  if (schedule.type !== "weekly" || !schedule.weekdays?.length) return "每日执行";
  const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `每周 ${schedule.weekdays.map((day) => labels[day]).join("、")} 执行`;
}

function nextRunDate(startTime = form.startTime.value, schedule = collectSchedule()) {
  const now = new Date();
  const date = new Date();
  if (!isClockTime(startTime)) return date;

  const [hours, minutes] = startTime.split(":").map(Number);
  const weekly = schedule.scheduleType === "weekly" && schedule.weekdays.length > 0;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() <= Date.now() - 5000) continue;
    if (weekly && !schedule.weekdays.includes(candidate.getDay())) continue;
    return candidate;
  }

  date.setDate(now.getDate() + 1);
  date.setHours(hours, minutes, 0, 0);
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]
  ));
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

function resetTaskNameField() {
  form.taskName.value = "";
  taskNameTouched = false;
}

function setDefaultStartTime() {
  const start = new Date(Date.now() + 5 * 60 * 1000);
  form.startTime.value = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
}

function setTaskEditorMode(task = null) {
  editingTaskId = task?.id || null;
  editingPasswordTouched = false;
  const editing = Boolean(editingTaskId);
  taskEditNotice.classList.toggle("hidden", !editing);
  taskEditText.textContent = editing ? `正在修改：${task.name || task.id}` : "";
  taskSubmitButton.textContent = editing ? "保存任务修改" : "创建定时任务";
  form.password.required = !editing;
  passwordLabel.textContent = editing ? "统一认证密码（不修改则保留）" : "统一认证密码";
  form.password.placeholder = editing ? "不填写新密码则保留原密码" : "统一身份认证密码";
  renderTasks();
}

function resetTaskFormForCreate({ preservePassword = true } = {}) {
  const password = preservePassword ? form.password.value : "";
  form.reset();
  form.account.value = currentUser?.boundStudentId || "";
  form.password.value = password;
  setDefaultStartTime();
  segmentsEl.innerHTML = "";
  lastDefaultSegmentDate = defaultSegmentDate();
  addSegment();
  updateScheduleControls();
  resetTaskNameField();
  setTaskEditorMode();
}

function ensureRoomOption(roomId) {
  if (!roomId || [...roomSelect.options].some((option) => option.value === roomId)) return;
  roomSelect.add(new Option(`已保存阅览区 ${roomId}`, roomId));
}

function startTaskEdit(taskId) {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;
  if (task.status === "running") {
    addLog({ level: "warn", message: "任务正在执行，请等待本次执行结束后再修改" });
    return;
  }

  const candidates = task.form.seatCandidates?.length
    ? task.form.seatCandidates
    : [task.form.seatNo].filter(Boolean);
  form.taskName.value = task.name || "";
  taskNameTouched = true;
  form.startTime.value = task.form.startTime || "";
  const scheduleType = task.form.schedule?.type === "weekly" ? "weekly" : "daily";
  const scheduleRadio = form.querySelector(`input[name="scheduleType"][value="${scheduleType}"]`);
  if (scheduleRadio) scheduleRadio.checked = true;
  const weekdays = new Set(task.form.schedule?.weekdays || []);
  for (const input of form.querySelectorAll('input[name="weekdays"]')) {
    input.checked = weekdays.has(Number(input.value));
  }
  form.seatNo.value = candidates[0] || "";
  form.seatNoAlt1.value = candidates[1] || "";
  form.seatNoAlt2.value = candidates[2] || "";
  ensureRoomOption(task.form.roomId);
  form.roomId.value = task.form.roomId || "";
  const modeRadio = form.querySelector(`input[name="mode"][value="${task.form.mode || "browser"}"]`);
  if (modeRadio) modeRadio.checked = true;
  document.querySelector("#visibleBrowser").checked = task.form.visibleBrowser !== false;
  segmentsEl.innerHTML = "";
  for (const segment of task.form.segments || []) {
    addSegment({ ...segment, date: segmentDisplayDate(task, segment) });
  }
  if (!segmentsEl.children.length) addSegment();
  updateScheduleControls();
  setTaskEditorMode(task);
  controlPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  form.taskName.focus({ preventScroll: true });
}

function markTaskNameTouched() {
  taskNameTouched = true;
}

function setControlsEnabled(enabled) {
  for (const element of form.elements) {
    if (element.id !== "account") element.disabled = !enabled;
  }
  document.querySelector("#addSegment").disabled = !enabled;
  document.querySelector("#refreshMenu").disabled = !enabled;
  document.querySelector("#previewSeat").disabled = !enabled;
}

function updateScheduleControls() {
  const schedule = collectSchedule();
  weekdayPicker.classList.toggle("hidden", schedule.scheduleType !== "weekly");
  updateDefaultSegmentDates();
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

function renderLogs() {
  const entries = tasks
    .flatMap((task) => (task.logs || []).map((entry) => ({ ...entry, taskName: task.name || task.id })))
    .sort((a, b) => (a.ts || new Date(a.at).getTime()) - (b.ts || new Date(b.at).getTime()));
  logBox.innerHTML = "";
  for (const entry of entries) {
    addLog({ ...entry, message: `【${entry.taskName}】${entry.message}` });
  }
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
    if (diff > 16 * 60) errors.push(`第 ${index + 1} 段超过 16 小时`);
  });
  return errors;
}

function statusText(status) {
  return {
    scheduled: "等待中",
    running: "执行中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
    paused: "已暂停",
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
      const paused = task.status === "paused";
      const running = task.status === "running";
      const nextText = paused ? "已暂停" : `下次执行 ${scheduledAt}`;
      const repeatText = scheduleLabel(task.form.schedule);
      return `
        <article class="task-card ${editingTaskId === task.id ? "editing" : ""}" data-id="${task.id}" tabindex="0" aria-label="修改任务 ${escapeHtml(task.name || task.id)}">
          <header>
            <span>${escapeHtml(task.name || task.id)} · ${statusText(task.status)}</span>
            <span>${escapeHtml(repeatText)} ${escapeHtml(task.form.startTime || "--:--")}</span>
          </header>
          <p>${escapeHtml(nextText)}；账号 ${escapeHtml(task.form.account)}；候选座位 ${escapeHtml(seats)}；将预约 ${escapeHtml(segments)}${escapeHtml(last)}</p>
          <div class="task-actions">
            <button class="secondary edit-task" ${running ? "disabled" : ""}>修改</button>
            <button class="secondary run-now" ${running || paused ? "disabled" : ""}>立即执行</button>
            <button class="secondary toggle-pause" ${running ? "disabled" : ""}>${paused ? "恢复执行" : "暂停执行"}</button>
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
  if (editingTaskId && !tasks.some((task) => task.id === editingTaskId)) resetTaskFormForCreate();
  renderTasks();
  renderLogs();
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
  const editing = Boolean(editingTaskId);
  const taskId = editingTaskId;
  const submitButton = taskSubmitButton;
  const segments = collectSegments();
  const seatCandidates = collectSeatCandidates();
  const schedule = collectSchedule();
  const errors = validateSegments(segments);
  if (!seatCandidates.length) errors.push("请输入座位号");
  if (schedule.scheduleType === "weekly" && schedule.weekdays.length === 0) errors.push("请选择至少一个每周执行日期");
  if (errors.length) {
    errors.forEach((message) => addLog({ level: "error", message }));
    return;
  }

  const payload = {
    startTime: form.startTime.value,
    scheduleType: schedule.scheduleType,
    weekdays: schedule.weekdays,
    seatNo: seatCandidates[0],
    seatCandidates,
    roomId: form.roomId.value,
    mode: new FormData(form).get("mode"),
    visibleBrowser: document.querySelector("#visibleBrowser").checked,
    segments,
  };
  const taskName = form.taskName.value.trim();
  if (editing || (taskNameTouched && taskName)) payload.name = taskName;
  if (!editing || editingPasswordTouched) payload.password = form.password.value;

  submitButton.disabled = true;
  try {
    const response = await fetch(editing ? `/api/tasks/${taskId}` : "/api/tasks", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error((data.errors || [data.message || (editing ? "修改失败" : "创建失败")]).join("；"));
    }
    if (editing) {
      addLog({ level: "success", message: `任务已修改：${data.task.name || data.task.id}` });
      resetTaskFormForCreate();
    } else {
      resetTaskNameField();
      addLog({ level: "success", message: `任务已创建：${data.task.name || data.task.id}` });
    }
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
  const button = event.target.closest("button");
  if (!button) {
    startTaskEdit(id);
    return;
  }
  if (button.classList.contains("edit-task")) {
    startTaskEdit(id);
    return;
  }
  if (button.classList.contains("run-now")) {
    if (await requestTaskAction(`/api/tasks/${id}/run-now`, "立即执行失败")) await loadTasks();
    return;
  }
  if (button.classList.contains("toggle-pause")) {
    const paused = card.querySelector(".toggle-pause").textContent.includes("恢复");
    if (await requestTaskAction(`/api/tasks/${id}/${paused ? "resume" : "pause"}`, paused ? "恢复失败" : "暂停失败")) {
      await loadTasks();
    }
    return;
  }
  if (button.classList.contains("trash-task")) {
    if (await requestTaskAction(`/api/tasks/${id}`, "删除失败", "DELETE")) {
      if (editingTaskId === id) resetTaskFormForCreate();
      await loadTasks();
    }
  }
}

async function requestTaskAction(url, fallbackMessage, method = "POST") {
  const response = await fetch(url, { method });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    addLog({ level: "error", message: data.message || fallbackMessage });
    return false;
  }
  return true;
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
    if (data.type === "log") {
      const task = tasks.find((item) => item.id === data.taskId);
      addLog({ ...data.entry, message: `【${task?.name || data.taskId}】${data.entry.message}` });
    }
    if (data.type === "task") {
      const index = tasks.findIndex((task) => task.id === data.task.id);
      if (index >= 0) tasks[index] = data.task;
      else tasks.unshift(data.task);
      renderTasks();
      renderLogs();
    }
    if (data.type === "task-deleted") {
      tasks = tasks.filter((task) => task.id !== data.taskId);
      if (editingTaskId === data.taskId) resetTaskFormForCreate();
      renderTasks();
      renderLogs();
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
  resetTaskFormForCreate();
  renderAuth();
  renderTasks();
  addLog({ level: "warn", message: "已退出系统账号" });
}

async function clearLogs() {
  if (!currentUser) return;
  const response = await fetch("/api/logs", { method: "DELETE" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    addLog({ level: "error", message: data.message || "清空日志失败" });
    return;
  }
  tasks = tasks.map((task) => ({ ...task, logs: [] }));
  renderLogs();
}

function tickClock() {
  document.querySelector("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

document.querySelector("#addSegment").addEventListener("click", () => addSegment());
document.querySelector("#refreshMenu").addEventListener("click", loadSeatMenu);
document.querySelector("#previewSeat").addEventListener("click", previewSeat);
taskListEl.addEventListener("click", handleTaskAction);
taskListEl.addEventListener("keydown", (event) => {
  if (!event.target.classList.contains("task-card") || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  startTaskEdit(event.target.dataset.id);
});
cancelTaskEditButton.addEventListener("click", () => resetTaskFormForCreate());
form.startTime.addEventListener("input", updateDefaultSegmentDates);
form.password.addEventListener("input", () => {
  if (editingTaskId) editingPasswordTouched = true;
});
form.taskName.addEventListener("beforeinput", markTaskNameTouched);
form.taskName.addEventListener("paste", markTaskNameTouched);
form.taskName.addEventListener("cut", markTaskNameTouched);
form.taskName.addEventListener("drop", markTaskNameTouched);
for (const input of form.querySelectorAll('input[name="scheduleType"], input[name="weekdays"]')) {
  input.addEventListener("change", updateScheduleControls);
}
form.addEventListener("submit", createTask);
loginForm.addEventListener("submit", login);
bindForm.addEventListener("submit", bindStudent);
logoutButton.addEventListener("click", logout);
clearLogsButton.addEventListener("click", clearLogs);
window.addEventListener("pageshow", () => {
  if (!editingTaskId) resetTaskNameField();
});

resetTaskFormForCreate({ preservePassword: false });
tickClock();
setInterval(tickClock, 1000);
renderAuth();
loadCurrentUser();
