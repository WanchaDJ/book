const loginPanel = document.querySelector("#adminLoginPanel");
const workspace = document.querySelector("#adminWorkspace");
const loginForm = document.querySelector("#adminLoginForm");
const createUserForm = document.querySelector("#createUserForm");
const logoutButton = document.querySelector("#adminLogoutButton");
const managedUsersEl = document.querySelector("#managedUsers");
const adminInfoText = document.querySelector("#adminInfoText");
const loginMessage = document.querySelector("#adminLoginMessage");
const adminMessage = document.querySelector("#adminMessage");

let currentAdmin = null;

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

function renderUsers(users = []) {
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

async function loadAdmin() {
  try {
    const data = await requestJson("/api/admin/me");
    currentAdmin = data.admin || null;
    renderSession();
    if (currentAdmin) await loadUsers();
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
    await loadUsers();
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
    await loadUsers();
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
    await loadUsers();
  } catch (error) {
    button.disabled = false;
    setMessage(adminMessage, error.message, "error");
  }
}

loginForm.addEventListener("submit", login);
createUserForm.addEventListener("submit", createUser);
logoutButton.addEventListener("click", logout);
managedUsersEl.addEventListener("click", handleUserAction);

renderSession();
loadAdmin();
