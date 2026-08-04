const loginPanel = document.querySelector("#adminLoginPanel");
const workspace = document.querySelector("#adminWorkspace");
const loginForm = document.querySelector("#adminLoginForm");
const createUserForm = document.querySelector("#createUserForm");
const logoutButton = document.querySelector("#adminLogoutButton");
const managedUsersEl = document.querySelector("#managedUsers");
const managedTasksEl = document.querySelector("#managedTasks");
const adminInfoText = document.querySelector("#adminInfoText");
const loginMessage = document.querySelector("#adminLoginMessage");
const adminMessage = document.querySelector("#adminMessage");
const adminTasksMessage = document.querySelector("#adminTasksMessage");
const accountsView = document.querySelector("#adminAccountsView");
const tasksView = document.querySelector("#adminTasksView");
const featureBar = document.querySelector(".admin-feature-bar");
const accountCount = document.querySelector("#accountCount");
const taskCount = document.querySelector("#taskCount");
const taskSummary = document.querySelector("#taskSummary");
const refreshTasksButton = document.querySelector("#refreshAdminTasks");

let currentAdmin = null;
let currentView = "accounts";

function setMessage(element, message = "", level = "") {
  element.textContent = message;
  element.className = `admin-message ${level}`.trim();
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function dateInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function renderSession() {
  const loggedIn = Boolean(currentAdmin);
  loginPanel.classList.toggle("hidden", loggedIn);
  workspace.classList.toggle("hidden", !loggedIn);
  adminInfoText.textContent = loggedIn ? `当前管理员：${currentAdmin.username}` : "";
}

function setView(view) {
  currentView = view === "tasks" ? "tasks" : "accounts";
  accountsView.classList.toggle("hidden", currentView !== "accounts");
  tasksView.classList.toggle("hidden", currentView !== "tasks");
  for (const button of featureBar.querySelectorAll("[data-admin-view]")) {
    const active = button.dataset.adminView === currentView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function renderUsers(users = []) {
  accountCount.textContent = String(users.length);
  if (!users.length) {
    managedUsersEl.innerHTML = `<div class="empty">暂无系统账号</div>`;
    return;
  }
  managedUsersEl.innerHTML = users
    .map(
      (user) => `
        <article class="managed-user" data-username="${escapeHtml(user.username)}">
          <strong>${escapeHtml(user.username)}</strong>
          <code>${escapeHtml(user.initialPassword || "旧账号无记录")}</code>
          <span>${escapeHtml(user.boundStudentId || "未绑定")}</span>
          <span>${escapeHtml(formatDate(user.createdAt))}</span>
          <button class="trash-task delete-user" type="button" title="删除账号" aria-label="删除 ${escapeHtml(user.username)}">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M6 6l1 15h10l1-15" />
              <path d="M10 11v6" />
              <path d="M14 11v6" />
            </svg>
          </button>
        </article>
      `,
    )
    .join("");
}

function statusText(status) {
  return {
    scheduled: "等待中",
    running: "执行中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
    paused: "已暂停",
  }[status] || status || "未知";
}

function scheduleText(schedule = { type: "daily", weekdays: [] }) {
  if (schedule.type !== "weekly" || !schedule.weekdays?.length) return "每日执行";
  const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `每周 ${schedule.weekdays.map((day) => labels[day]).join("、")}`;
}

function segmentDate(task, segment) {
  if (typeof segment.dayOffset !== "number" || !task.scheduledAt) return segment.date || "-";
  return dateInput(addDays(new Date(task.scheduledAt), segment.dayOffset));
}

function renderSeatCandidates(task) {
  const candidates = task.form.seatCandidates?.length
    ? task.form.seatCandidates
    : [task.form.seatNo].filter(Boolean);
  const candidateTags = candidates
    .map(
      (seat, index) => `<span class="seat-tag ${index === 0 ? "primary-seat" : ""}">
        ${index === 0 ? "主座位" : `备选 ${index}`} <strong>${escapeHtml(seat)}</strong>
      </span>`,
    )
    .join("");
  const customSeats = task.form.fallbackCustomSeats || [];
  const fallbackTag = !task.form.fallbackEnabled
    ? ""
    : task.form.fallbackMode === "custom"
      ? `<span class="seat-tag fallback-seat fallback-custom-seat">超强自定义 <strong>${escapeHtml(customSeats.join(" → ") || "-")}</strong></span>
        <span class="seat-tag fallback-seat">最终遍历 <strong>${escapeHtml(task.form.fallbackSeatStart || "-")} 至 ${escapeHtml(task.form.fallbackSeatEnd || "-")}</strong></span>`
      : `<span class="seat-tag fallback-seat">盲盒随机 <strong>${escapeHtml(task.form.fallbackSeatStart || "-")} 至 ${escapeHtml(task.form.fallbackSeatEnd || "-")}</strong></span>`;
  return candidateTags || fallbackTag ? `${candidateTags}${fallbackTag}` : `<span class="muted-value">未填写座位</span>`;
}

function renderTask(task) {
  const segments = task.form.segments?.length
    ? task.form.segments.map((segment) => `${segmentDate(task, segment)} ${segment.begin}-${segment.end}`).join("；")
    : "未设置预约时间段";
  const nextRun = task.status === "paused" ? "任务已暂停" : `下次执行 ${formatDate(task.scheduledAt)}`;
  const runResult = task.runCount
    ? `已执行 ${task.runCount} 次${task.lastRunOk === false ? "，上次失败" : ""}`
    : "尚未执行";
  const statusClass = ["scheduled", "running", "done", "failed", "cancelled", "paused"].includes(task.status)
    ? task.status
    : "unknown";
  const paused = task.status === "paused";
  const running = task.status === "running";
  const action = paused ? "resume" : "pause";
  const actionText = paused ? "恢复任务" : "暂停任务";
  const actionTitle = running ? "任务正在执行，当前流程结束后才能暂停" : actionText;

  return `
    <article class="admin-task-row" data-task-id="${escapeHtml(task.id)}">
      <header>
        <div>
          <strong>${escapeHtml(task.name || task.id)}</strong>
          <span class="admin-task-id">${escapeHtml(task.id)}</span>
        </div>
        <div class="admin-task-head-actions">
          <span class="task-status ${statusClass}">${escapeHtml(statusText(task.status))}</span>
          <button
            type="button"
            class="secondary admin-task-toggle ${paused ? "resume" : ""}"
            data-task-action="${action}"
            ${running ? "disabled" : ""}
            title="${escapeHtml(actionTitle)}"
          >${escapeHtml(actionText)}</button>
        </div>
      </header>
      <div class="seat-chain" aria-label="候选座位">${renderSeatCandidates(task)}</div>
      <dl class="admin-task-details">
        <div><dt>执行规则</dt><dd>${escapeHtml(scheduleText(task.form.schedule))}，${escapeHtml(task.form.startTime || "-")} 开始抢座</dd></div>
        <div><dt>预约时段</dt><dd>${escapeHtml(segments)}</dd></div>
        <div><dt>运行状态</dt><dd>${escapeHtml(nextRun)}；${escapeHtml(runResult)}</dd></div>
      </dl>
    </article>
  `;
}

function renderTasks(users = [], updatedAt = null) {
  const totalTasks = users.reduce((sum, user) => sum + user.tasks.length, 0);
  const activeTasks = users.reduce(
    (sum, user) => sum + user.tasks.filter((task) => ["scheduled", "running"].includes(task.status)).length,
    0,
  );
  taskCount.textContent = String(totalTasks);
  taskSummary.textContent = `${users.length} 个用户，${totalTasks} 个任务，其中 ${activeTasks} 个正在等待或执行${updatedAt ? `；更新于 ${formatDate(updatedAt)}` : ""}`;

  if (!users.length) {
    managedTasksEl.innerHTML = `<div class="empty">暂无系统账号和任务</div>`;
    return;
  }

  managedTasksEl.innerHTML = users
    .map(
      (user) => `
        <section class="admin-task-user">
          <header class="admin-task-user-head">
            <div>
              <h3>${escapeHtml(user.username)}</h3>
              <span>绑定学号：${escapeHtml(user.boundStudentId || "未绑定")}</span>
            </div>
            <strong>${user.tasks.length} 个任务</strong>
          </header>
          <div class="admin-task-list">
            ${user.tasks.length ? user.tasks.map(renderTask).join("") : `<div class="empty compact-empty">该用户暂无任务</div>`}
          </div>
        </section>
      `,
    )
    .join("");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.message || "请求失败");
  return data;
}

async function loadUsers() {
  const data = await requestJson("/api/admin/users");
  renderUsers(data.users || []);
}

async function loadTasks() {
  setMessage(adminTasksMessage);
  refreshTasksButton.disabled = true;
  try {
    const data = await requestJson("/api/admin/tasks");
    renderTasks(data.users || [], data.updatedAt);
  } catch (error) {
    setMessage(adminTasksMessage, error.message, "error");
    throw error;
  } finally {
    refreshTasksButton.disabled = false;
  }
}

async function loadAdmin() {
  try {
    const data = await requestJson("/api/admin/me");
    currentAdmin = data.admin || null;
    renderSession();
    if (currentAdmin) await Promise.all([loadUsers(), loadTasks()]);
  } catch (error) {
    currentAdmin = null;
    renderSession();
    setMessage(loginMessage, error.message, "error");
  }
}

async function login(event) {
  event.preventDefault();
  setMessage(loginMessage);
  const button = loginForm.querySelector("button");
  button.disabled = true;
  try {
    const data = await requestJson("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.querySelector("#adminUsername").value,
        password: document.querySelector("#adminPassword").value,
      }),
    });
    currentAdmin = data.admin;
    document.querySelector("#adminPassword").value = "";
    renderSession();
    setMessage(adminMessage, "管理员已登录", "success");
    await Promise.all([loadUsers(), loadTasks()]);
  } catch (error) {
    setMessage(loginMessage, error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  await fetch("/api/admin/logout", { method: "POST" });
  currentAdmin = null;
  renderSession();
  renderUsers([]);
  renderTasks([]);
  setView("accounts");
  setMessage(loginMessage, "已退出管理员账号", "success");
}

async function createUser(event) {
  event.preventDefault();
  setMessage(adminMessage);
  const button = createUserForm.querySelector("button");
  button.disabled = true;
  try {
    const data = await requestJson("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username: document.querySelector("#newUsername").value,
        password: document.querySelector("#newPassword").value,
      }),
    });
    createUserForm.reset();
    setMessage(adminMessage, `已生成账号 ${data.user.username}，初始密码：${data.user.initialPassword}`, "success");
    await Promise.all([loadUsers(), loadTasks()]);
  } catch (error) {
    setMessage(adminMessage, error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function handleUserAction(event) {
  const button = event.target.closest(".delete-user");
  if (!button) return;
  const row = button.closest(".managed-user");
  const username = row?.dataset.username;
  if (!username) return;
  const confirmed = window.confirm(`确定删除系统账号 ${username} 吗？该账号的定时任务也会被清除。`);
  if (!confirmed) return;
  button.disabled = true;
  try {
    await requestJson(`/api/admin/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    setMessage(adminMessage, `已删除账号 ${username}`, "success");
    await Promise.all([loadUsers(), loadTasks()]);
  } catch (error) {
    button.disabled = false;
    setMessage(adminMessage, error.message, "error");
  }
}

async function handleTaskAction(event) {
  const button = event.target.closest(".admin-task-toggle");
  if (!button || button.disabled) return;
  const row = button.closest(".admin-task-row");
  const taskId = row?.dataset.taskId;
  const action = button.dataset.taskAction;
  if (!taskId || !["pause", "resume"].includes(action)) return;

  const actionText = action === "pause" ? "暂停" : "恢复";
  button.disabled = true;
  setMessage(adminTasksMessage);
  try {
    await requestJson(`/api/admin/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
    await loadTasks();
    setMessage(adminTasksMessage, `任务已${actionText}`, "success");
  } catch (error) {
    button.disabled = false;
    setMessage(adminTasksMessage, error.message, "error");
  }
}

loginForm.addEventListener("submit", login);
createUserForm.addEventListener("submit", createUser);
logoutButton.addEventListener("click", logout);
managedUsersEl.addEventListener("click", handleUserAction);
managedTasksEl.addEventListener("click", handleTaskAction);
featureBar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-admin-view]");
  if (!button) return;
  setView(button.dataset.adminView);
  if (currentView === "tasks") loadTasks().catch(() => {});
});
refreshTasksButton.addEventListener("click", () => loadTasks().catch(() => {}));

renderSession();
setView("accounts");
loadAdmin();
