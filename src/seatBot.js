import { chromium } from "@playwright/test";
import { expandSeatRange } from "./seatRange.js";
import { hasSeatReservationConflict } from "./seatAvailability.js";

export const TARGET = {
  baseUrl: "https://tsgzw1.qdhhc.edu.cn",
  mobileReserveUrl: "https://tsgzw1.qdhhc.edu.cn/mobile.html#/ic/reserveList",
  apiBase: "https://tsgzw1.qdhhc.edu.cn/ic-web",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_FORM_TIMEOUT_MS = 15000;
const LOGIN_VERIFY_TIMEOUT_MS = 12000;
const AUTH_API_TIMEOUT_MS = 6000;
const OFFICIAL_API_TIMEOUT_MS = 20000;

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function shouldRunHeadless(form) {
  if (isTruthyEnv(process.env.FORCE_HEADLESS)) return true;
  if (process.env.NODE_ENV === "production") return true;
  return !form.visibleBrowser;
}

export async function fetchSeatMenu() {
  const response = await fetch(`${TARGET.apiBase}/seatMenu`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`座位菜单查询失败：HTTP ${response.status}`);
  const data = await response.json();
  if (data.code !== 0) throw new Error(data.message || "座位菜单查询失败");
  return data.data || [];
}

function formatDateTime(segment, edge) {
  const time = edge === "begin" ? segment.begin : segment.end;
  return `${segment.date} ${time}:00`;
}

function seatNoVariants(seatNo) {
  const raw = seatNo.trim();
  const compact = raw.replace(/\s+/g, "");
  const stripped = compact.replace(/^0+/, "");
  return [...new Set([raw, compact, stripped, `座位${stripped}`, `${stripped}号`].filter(Boolean))];
}

function seatCandidates(form) {
  const values = Array.isArray(form.seatCandidates) ? form.seatCandidates : [form.seatNo];
  if (form.seatNo && !values.includes(form.seatNo)) values.unshift(form.seatNo);

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

function fallbackSeatCandidates(form) {
  if (form.fallbackEnabled !== true) return [];
  return expandSeatRange(form.fallbackSeatStart, form.fallbackSeatEnd);
}

async function clickFirstVisible(page, selectors, options = {}) {
  const timeout = options.timeout || 3000;
  const deadline = Date.now() + timeout;
  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!(await locator.isVisible().catch(() => false))) continue;
      try {
        await locator.click({ timeout: Math.max(250, deadline - Date.now()), noWaitAfter: true });
        return selector;
      } catch {}
    }
    if (Date.now() < deadline) await page.waitForTimeout(150).catch(() => {});
  } while (Date.now() < deadline);
  return null;
}

async function fillFirstVisible(page, selectors, value, options = {}) {
  const timeout = options.timeout || 3000;
  const deadline = Date.now() + timeout;
  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (!(await locator.isVisible().catch(() => false))) continue;
      try {
        await locator.fill(value, { timeout: Math.max(250, deadline - Date.now()) });
        return selector;
      } catch {}
    }
    if (Date.now() < deadline) await page.waitForTimeout(150).catch(() => {});
  } while (Date.now() < deadline);
  return null;
}

async function withTimeoutFallback(promise, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isAuthUrl(value) {
  return /authserver|authcenter|\/login(?:[/?#]|$)/i.test(String(value || ""));
}

function loginFailure(message, retryable = true) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

function isRetryableLoginError(error) {
  if (typeof error?.retryable === "boolean") return error.retryable;
  return !/验证码|滑块|密码错误|账号或密码|用户名或密码|账号.{0,6}(?:锁定|冻结|停用)|绑定学号不一致|登录账号与绑定学号不一致/.test(
    String(error?.message || ""),
  );
}

function conciseErrorMessage(error, maxLength = 160) {
  const message = String(error?.message || error || "未知错误")
    .replace(/；提交摘要[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

async function hasActiveChallenge(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const captchaInputs = [...document.querySelectorAll("input#captcha, input[name='captcha']")];
    if (captchaInputs.some((input) => visible(input) && !input.disabled)) return true;

    const slider = document.querySelector("#sliderCaptchaDiv");
    if (!visible(slider)) return false;
    return Boolean(slider.querySelector("canvas, iframe, img, input, button, .slider, [class*='captcha'], [class*='verify']"));
  }).catch(() => false);
}

async function loginOnce(page, form, log) {
  log("info", "官网登录：正在打开认证页面", { logKey: "login" });
  await page.goto(TARGET.mobileReserveUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const accountSelectors = [
    "input#username[name='username']",
    "input[name='username']",
    "input[placeholder*='学号']",
    "input[placeholder*='账号']",
    "input[placeholder*='用户']",
  ];
  const loginFormVisible = await page
    .locator(accountSelectors.join(", "))
    .first()
    .waitFor({ state: "visible", timeout: LOGIN_FORM_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);

  if (!loginFormVisible && !isAuthUrl(page.url())) {
    log("info", "官网登录：正在验证已有登录状态", { logKey: "login" });
    return;
  }

  log("info", "官网登录：正在提交账号密码", { logKey: "login" });
  await page.evaluate(() => {
    document.querySelectorAll("input[readonly]").forEach((input) => input.removeAttribute("readonly"));
  });

  const accountFilled = await fillFirstVisible(
    page,
    accountSelectors,
    form.account,
    { timeout: 4000 },
  );
  if (!accountFilled) throw loginFailure("没有找到账号输入框，登录页可能尚未加载完成");

  const passwordFilled = await fillFirstVisible(
    page,
    [
      "input#password",
      "input[name='passwordText']",
      "input[type='password']",
      "input[placeholder*='密码']",
    ],
    form.password,
    { timeout: 4000 },
  );
  if (!passwordFilled) throw loginFailure("没有找到密码输入框，登录页可能尚未加载完成");

  if (await hasActiveChallenge(page)) {
    throw loginFailure("登录页出现验证码或滑块，需要手动完成；本工具不会自动识别验证码", false);
  }

  const clicked = await clickFirstVisible(page, [
    "#login_submit",
    "a.login-btn",
    "button:has-text('登录')",
    "form button[type='submit']",
    "input[type='submit']",
    "[role='button']:has-text('登录')",
    "text=登录",
  ], { timeout: 4000 });
  if (!clicked) throw loginFailure("没有找到或无法点击登录按钮，登录页可能尚未加载完成");

  await Promise.race([
    page.waitForURL((url) => !isAuthUrl(url.toString()), { timeout: LOGIN_VERIFY_TIMEOUT_MS }).catch(() => {}),
    page.locator("#showErrorTip, .form-error, .form-errorTip").first().waitFor({ state: "visible", timeout: LOGIN_VERIFY_TIMEOUT_MS }).catch(() => {}),
    page.waitForTimeout(LOGIN_VERIFY_TIMEOUT_MS),
  ]);

  if (isAuthUrl(page.url())) {
    if (await hasActiveChallenge(page)) {
      throw loginFailure("登录页出现验证码或滑块，需要手动完成；本工具不会自动识别验证码", false);
    }
    const errorText = await page
      .locator("#showErrorTip, .form-error, .form-errorTip")
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => "");
    if (errorText) {
      const retryable = !/验证码|密码错误|账号或密码|用户名或密码|锁定|冻结|停用/.test(errorText);
      throw loginFailure(`登录未完成：${errorText}`, retryable);
    }
    throw loginFailure("登录提交后仍未建立官网会话，可能是认证页面响应超时");
  }
  log("info", "官网登录：已提交，正在确认登录结果", { logKey: "login" });
}

async function login(context, page, form, log, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
    if (options.clearBeforeFirst || attempt > 1) {
      await clearOfficialSession(context, page);
    }
    log("info", `官网登录：第 ${attempt}/${LOGIN_MAX_ATTEMPTS} 次尝试`, { logKey: "login" });
    try {
      await loginOnce(page, form, log);
      const userInfo = await waitForLoggedInUserInfo(context);
      assertLoggedInAccount(userInfo, form);
      await cacheUserInfoOnPage(page, userInfo);
      log("success", `官网登录：成功（第 ${attempt}/${LOGIN_MAX_ATTEMPTS} 次尝试）`, { logKey: "login" });
      return userInfo;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableLoginError(error);
      log("warn", `官网登录：第 ${attempt}/${LOGIN_MAX_ATTEMPTS} 次失败，${conciseErrorMessage(error)}`, { logKey: "login" });
      if (!retryable) throw error;
      if (attempt < LOGIN_MAX_ATTEMPTS) {
        await page.waitForTimeout(Math.min(attempt * 1000, 3000)).catch(() => {});
      }
    }
  }
  throw new Error(`官网登录重试 ${LOGIN_MAX_ATTEMPTS} 次仍失败：${conciseErrorMessage(lastError)}`);
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
}

function normalizeDigits(value) {
  const digits = String(value ?? "").match(/\d+/g)?.join("") || "";
  return digits.replace(/^0+/, "") || digits;
}

function assertLoggedInAccount(userInfo, form) {
  const expected = normalizeDigits(form.account);
  const values = [userInfo.accNo, userInfo.logonName, userInfo.account].filter(Boolean);
  if (!expected || !values.length) return;
  const matched = values.some((value) => normalizeDigits(value) === expected);
  if (!matched) {
    throw new Error(`登录账号与绑定学号不一致：当前会话为 ${values.join(" / ")}，绑定学号为 ${form.account}`);
  }
}

function parseStorageJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pickUserInfo(value, depth = 0) {
  if (!value || depth > 4) return null;
  if (typeof value === "string") return pickUserInfo(parseStorageJson(value), depth + 1);
  if (typeof value !== "object") return null;
  if (value.token || value.accNo || value.logonName) return value;
  for (const key of ["userInfo", "user", "data"]) {
    const nested = pickUserInfo(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function readUserInfoFromPage(page) {
  const values = await withTimeoutFallback(
    page
      .evaluate(() => {
        const collect = (store) => {
          const rows = [];
          for (let index = 0; index < store.length; index += 1) {
            const key = store.key(index);
            if (/userInfo|vuex/i.test(key)) rows.push(store.getItem(key));
          }
          return rows;
        };
        return [...collect(window.sessionStorage), ...collect(window.localStorage)];
      })
      .catch(() => []),
    3000,
    [],
  );

  for (const value of values) {
    const userInfo = pickUserInfo(value);
    if (userInfo) return userInfo;
  }
  return null;
}

function apiHeaders(userInfo = {}) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    lan: "1",
    origin: TARGET.baseUrl,
    referer: TARGET.mobileReserveUrl,
    "user-agent": USER_AGENT,
  };
  if (userInfo.token) headers.token = String(userInfo.token);
  return headers;
}

async function readApiResponse(response, action) {
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!response.ok()) {
    throw new Error(`${action}失败：HTTP ${response.status()} ${text.slice(0, 160)}`);
  }
  return data ?? { code: -1, message: text };
}

async function apiGet(context, userInfo, path, params, action, options = {}) {
  const response = await context.request.get(`${TARGET.apiBase}/${path.replace(/^\/+/, "")}`, {
    params,
    headers: apiHeaders(userInfo),
    timeout: options.timeout || OFFICIAL_API_TIMEOUT_MS,
  });
  return readApiResponse(response, action);
}

async function apiPost(context, userInfo, path, payload, action, options = {}) {
  const response = await context.request.post(`${TARGET.apiBase}/${path.replace(/^\/+/, "")}`, {
    data: payload,
    headers: {
      ...apiHeaders(userInfo),
      "content-type": "application/json;charset=UTF-8",
    },
    timeout: options.timeout || OFFICIAL_API_TIMEOUT_MS,
  });
  return readApiResponse(response, action);
}

async function fetchLoggedInUserInfo(context) {
  const data = await apiGet(context, {}, "auth/userInfo", {}, "读取用户信息", { timeout: AUTH_API_TIMEOUT_MS });
  if (data?.code !== 0 || !data.data) {
    throw new Error(data?.message || "没有从登录会话中取得用户信息");
  }
  return data.data;
}

async function waitForLoggedInUserInfo(context) {
  const deadline = Date.now() + LOGIN_VERIFY_TIMEOUT_MS;
  let lastError = null;
  do {
    try {
      return await fetchLoggedInUserInfo(context);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } while (Date.now() < deadline);
  throw lastError || new Error("等待官网登录状态超时");
}

async function cacheUserInfoOnPage(page, userInfo) {
  await withTimeoutFallback(
    page
      .evaluate((info) => {
        window.sessionStorage.setItem("userInfo", JSON.stringify(info));
        window.sessionStorage.setItem("isLogin", "true");
      }, userInfo)
      .catch(() => {}),
    3000,
    null,
  );
}

async function clearOfficialSession(context, page) {
  await context.clearCookies().catch(() => {});
  await withTimeoutFallback(
    page
      .evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      })
      .catch(() => {}),
    3000,
    null,
  );
  await page.goto("about:blank", { waitUntil: "commit", timeout: 5000 }).catch(() => {});
}

function officialAccNo(userInfo, form) {
  return String(userInfo?.accNo || userInfo?.logonName || userInfo?.account || form.account || "").trim();
}

async function getLoggedInUserInfo(context, page, form, log) {
  const cachedUserInfo = await readUserInfoFromPage(page);
  if (cachedUserInfo) {
    try {
      assertLoggedInAccount(cachedUserInfo, form);
    } catch (error) {
      log("warn", "官网登录：缓存状态已过期，正在重新确认", { logKey: "login" });
    }
  }

  let userInfo;
  try {
    userInfo = await fetchLoggedInUserInfo(context);
  } catch (error) {
    log("warn", `官网登录：状态已失效，准备重新登录（最多 ${LOGIN_MAX_ATTEMPTS} 次）`, { logKey: "login" });
    return login(context, page, form, log, { clearBeforeFirst: true });
  }

  assertLoggedInAccount(userInfo, form);
  await cacheUserInfoOnPage(page, userInfo);
  return userInfo;
}

function flattenRooms(nodes, trail = [], out = []) {
  for (const node of nodes || []) {
    const name = node.name || node.roomName || node.label || "";
    const nextTrail = name ? [...trail, name] : trail;
    if (Array.isArray(node.children) && node.children.length > 0) {
      flattenRooms(node.children, nextTrail, out);
    } else {
      const id = node.id ?? node.roomId ?? node.roomIds;
      if (id != null) out.push({ id: String(id), label: nextTrail.join(" / ") || String(id) });
    }
  }
  return out;
}

async function getRoomCandidates(form, log) {
  if (form.roomId) return [{ id: String(form.roomId), label: `阅览区 ${form.roomId}` }];

  const rooms = flattenRooms(await fetchSeatMenu());
  if (!rooms.length) throw new Error("没有读取到可用阅览区，无法自动识别座位所在区域");
  return rooms;
}

function collectSeatDevices(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectSeatDevices(item, out));
    return out;
  }
  if (typeof value !== "object") return out;

  const hasDevId = value.devId != null || value.deviceId != null;
  const hasSeatName = ["devName", "devSn", "devNo", "devCode", "seatNo"].some((key) => value[key] != null);
  if (hasDevId && hasSeatName) out.push(value);

  for (const [key, child] of Object.entries(value)) {
    if (["resvInfo", "openTimes", "resvRule"].includes(key)) continue;
    if (child && typeof child === "object") collectSeatDevices(child, out);
  }
  return out;
}

function fieldMatchesSeat(value, seatNo, allowNumericAlias = true) {
  const targetText = normalizeText(seatNo);
  const targetDigits = normalizeDigits(seatNo);
  const text = normalizeText(value);
  const digits = normalizeDigits(value);

  if (!text) return false;
  if (text === targetText) return true;
  return Boolean(allowNumericAlias && targetDigits && digits && digits === targetDigits);
}

function seatMatchInfo(device, seatNo) {
  const primaryFields = ["devName", "seatNo", "seatName"];
  for (const field of primaryFields) {
    if (fieldMatchesSeat(device[field], seatNo, true)) {
      return { field, value: String(device[field]) };
    }
  }

  const fallbackFields = ["devNo", "devCode", "realDevCode", "realdevCode"];
  for (const field of fallbackFields) {
    if (fieldMatchesSeat(device[field], seatNo, false)) {
      return { field, value: String(device[field]) };
    }
  }

  return null;
}

function seatLabel(device) {
  return (
    device.devName ??
    device.seatNo ??
    device.seatName ??
    device.devNo ??
    device.devCode ??
    device.seatNo ??
    `devId=${device.devId ?? device.deviceId}`
  );
}

function publicDeviceInfo(device) {
  return {
    devId: device.devId ?? device.deviceId,
    devName: device.devName,
    devSn: device.devSn,
    devNo: device.devNo,
    devCode: device.devCode,
    seatNo: device.seatNo,
    seatName: device.seatName,
    label: seatLabel(device),
  };
}

async function findSeatDevice(context, userInfo, form, segment, log, seatNo = form.seatNo) {
  const rooms = await getRoomCandidates(form, log);
  const resvDate = segment.date.replace(/-/g, "");
  const checked = [];
  let samples = [];

  for (const room of rooms) {
    const data = await apiGet(
      context,
      userInfo,
      "reserve",
      { roomIds: room.id, resvDates: resvDate, sysKind: 8 },
      `读取 ${room.label} 座位图`,
    );
    if (data?.code !== 0) {
      if (form.roomId) throw new Error(data?.message || `读取 ${room.label} 座位图失败`);
      continue;
    }

    const devices = collectSeatDevices(data.data);
    checked.push(`${room.label}(${devices.length})`);
    if (!samples.length) samples = devices.slice(0, 8).map(seatLabel);

    const match = devices.find((device) => seatMatchInfo(device, seatNo));
    if (match) {
      const matchInfo = seatMatchInfo(match, seatNo);
      return { room, device: match, matchInfo };
    }
  }

  const variants = seatNoVariants(seatNo).join(" / ");
  const sampleText = samples.length ? `；座位样例：${samples.join("、")}` : "";
  throw new Error(`没有在座位图数据中找到座位 ${variants}。已检查：${checked.join("，") || "无"}${sampleText}`);
}

async function findFallbackSeatDevices(context, userInfo, form, segment, log, requestedSeats) {
  const rooms = await getRoomCandidates(form, log);
  const resvDate = segment.date.replace(/-/g, "");
  const checked = [];

  for (const room of rooms) {
    const data = await apiGet(
      context,
      userInfo,
      "reserve",
      { roomIds: room.id, resvDates: resvDate, sysKind: 8 },
      `读取 ${room.label} 兜底座位图`,
    );
    if (data?.code !== 0) {
      if (form.roomId) throw new Error(data?.message || `读取 ${room.label} 座位图失败`);
      checked.push(`${room.label}(读取失败)`);
      continue;
    }

    const devices = collectSeatDevices(data.data);
    checked.push(`${room.label}(${devices.length})`);
    const seenDevices = new Set();
    const matches = [];
    for (const seatNo of requestedSeats) {
      const device = devices.find((item) => seatMatchInfo(item, seatNo));
      if (!device) continue;
      const devId = String(device.devId ?? device.deviceId ?? "");
      if (!devId || seenDevices.has(devId)) continue;
      seenDevices.add(devId);
      matches.push({ room, device, seatNo });
    }
    if (matches.length) {
      return matches;
    }
  }

  throw new Error(`兜底区间未匹配到座位。已检查：${checked.join("，") || "无"}`);
}

async function checkDeviceTips(context, userInfo, device, segment) {
  const devId = device.devId ?? device.deviceId;
  const ruleId = device.resvRule?.ruleId ?? device.resvRuleId;
  if (!devId || !ruleId) return;

  const data = await apiGet(
    context,
    userInfo,
    "device/tips",
    {
      devId,
      classKind: 8,
      resvRuleId: ruleId,
      chooseBeginTime: formatDateTime(segment, "begin"),
      isConsole: false,
    },
    "检查座位预约条件",
  );
  if (data?.code !== 0) throw new Error(data?.message || "座位当前不可预约");
}

async function reserveMatchedSeat(context, userInfo, form, segment, index, log, match, label, progressKey) {
  const { room, device, seatNo } = match;
  await checkDeviceTips(context, userInfo, device, segment);

  const accNo = officialAccNo(userInfo, form);
  const devId = device.devId ?? device.deviceId;
  if (!accNo) throw new Error("没有从登录会话中取得官网账号字段 accNo，无法提交预约");
  if (!devId) throw new Error(`座位 ${seatLabel(device)} 缺少 devId，无法提交预约`);

  const payload = {
    testName: form.testName || "",
    appAccNo: accNo,
    memberKind: 1,
    resvDev: [devId],
    resvMember: [accNo],
    resvProperty: 0,
    sysKind: 8,
    resvBeginTime: formatDateTime(segment, "begin"),
    resvEndTime: formatDateTime(segment, "end"),
  };

  const data = await apiPost(context, userInfo, "reserve", payload, `提交第 ${index + 1} 段预约`);
  if (data?.code !== 0) {
    const payloadSummary = {
      appAccNo: payload.appAccNo,
      resvMember: payload.resvMember,
      resvDev: payload.resvDev,
      sysKind: payload.sysKind,
      resvBeginTime: payload.resvBeginTime,
      resvEndTime: payload.resvEndTime,
    };
    throw new Error(`${data?.message || `第 ${index + 1} 段预约失败`}；提交摘要 ${JSON.stringify(payloadSummary)}`);
  }

  log(
    "success",
    `第 ${index + 1} 段预约成功：${label} ${seatNo}（${room.label} / ${seatLabel(device)}）`,
    { logKey: progressKey },
  );
  return {
    ok: true,
    roomId: room.id,
    requestedSeat: seatNo,
    seat: seatLabel(device),
    devId,
    fallback: label === "区间兜底",
    data,
  };
}

async function submitOfficialReserve(context, page, form, segment, index, log) {
  const progressKey = `segment-${index + 1}`;
  log(
    "info",
    `第 ${index + 1} 段：准备预约 ${formatDateTime(segment, "begin")} 至 ${formatDateTime(segment, "end")}`,
    { logKey: progressKey },
  );

  const userInfo = await getLoggedInUserInfo(context, page, form, log);
  const candidates = seatCandidates(form);
  const failures = [];
  if (!candidates.length) throw new Error("没有可用候选座位");

  for (let seatIndex = 0; seatIndex < candidates.length; seatIndex += 1) {
    const seatNo = candidates[seatIndex];
    const label = seatIndex === 0 ? "主座位" : `备选座位 ${seatIndex}`;
    log(
      "info",
      `第 ${index + 1} 段：指定座位 ${seatIndex + 1}/${candidates.length}，正在尝试 ${label} ${seatNo}`,
      { logKey: progressKey },
    );

    try {
      const { room, device } = await findSeatDevice(context, userInfo, form, segment, log, seatNo);
      return await reserveMatchedSeat(
        context,
        userInfo,
        form,
        segment,
        index,
        log,
        { room, device, seatNo },
        label,
        progressKey,
      );
    } catch (error) {
      failures.push(`${seatNo}：${conciseErrorMessage(error)}`);
    }
  }

  if (form.fallbackEnabled !== true) {
    throw new Error(
      `第 ${index + 1} 段指定座位全部失败：已尝试 ${failures.length}/${candidates.length}，最后结果：${failures.at(-1) || "官网未返回具体原因"}`,
    );
  }

  const explicitKeys = new Set(candidates.map(normalizeText));
  const rangeSeats = fallbackSeatCandidates(form).filter((seatNo) => !explicitKeys.has(normalizeText(seatNo)));
  if (!rangeSeats.length) {
    throw new Error(`第 ${index + 1} 段指定座位均失败，兜底区间没有额外可尝试座位`);
  }
  log(
    "warn",
    `第 ${index + 1} 段：指定座位均失败，正在读取兜底区间 ${form.fallbackSeatStart} 至 ${form.fallbackSeatEnd}`,
    { logKey: progressKey },
  );

  const matches = await findFallbackSeatDevices(context, userInfo, form, segment, log, rangeSeats);
  const availableMatches = matches.filter((match) => !hasSeatReservationConflict(match.device, segment));
  const occupiedCount = matches.length - availableMatches.length;
  log(
    "info",
    `第 ${index + 1} 段：兜底匹配 ${matches.length} 个座位，排除占用 ${occupiedCount} 个，准备尝试 ${availableMatches.length} 个`,
    { logKey: progressKey },
  );
  if (!availableMatches.length) {
    throw new Error(`第 ${index + 1} 段兜底区间内没有目标时段可尝试的空闲座位`);
  }

  const fallbackFailures = [];
  for (let fallbackIndex = 0; fallbackIndex < availableMatches.length; fallbackIndex += 1) {
    const match = availableMatches[fallbackIndex];
    log(
      "info",
      `第 ${index + 1} 段：兜底目前尝试到 ${fallbackIndex + 1}/${availableMatches.length}，当前座位 ${match.seatNo}`,
      { logKey: progressKey },
    );
    try {
      return await reserveMatchedSeat(
        context,
        userInfo,
        form,
        segment,
        index,
        log,
        match,
        "区间兜底",
        progressKey,
      );
    } catch (error) {
      fallbackFailures.push(`${match.seatNo}：${conciseErrorMessage(error)}`);
    }
  }

  const lastFailure = fallbackFailures.at(-1) || "官网未返回具体原因";
  throw new Error(`第 ${index + 1} 段兜底失败：已尝试 ${availableMatches.length}/${availableMatches.length}，最后结果：${lastFailure}`);
}

export async function runSeatTask(form, log) {
  const headless = shouldRunHeadless(form);
  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: USER_AGENT,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const page = await context.newPage();

  try {
    await login(context, page, form, log);

    const results = [];
    for (let index = 0; index < form.segments.length; index += 1) {
      const segment = form.segments[index];
      results.push(await submitOfficialReserve(context, page, form, segment, index, log));
      await page.waitForTimeout(1200);
    }

    return {
      ok: true,
      message: `执行完成，共处理 ${results.length} 个时间段。请在官网预约记录中最终确认。`,
      results,
    };
  } finally {
    if (!headless) await page.waitForTimeout(20000).catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function previewSeatMatch(form, log) {
  const headless = shouldRunHeadless(form);
  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: USER_AGENT,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const page = await context.newPage();

  try {
    await login(context, page, form, log);
    const userInfo = await getLoggedInUserInfo(context, page, form, log);
    const segment = { date: form.date, begin: "08:00", end: "09:00" };
    const candidates = seatCandidates(form);
    const matches = [];
    const failures = [];
    for (const seatNo of candidates) {
      try {
        const { room, device, matchInfo } = await findSeatDevice(context, userInfo, form, segment, log, seatNo);
        matches.push({ seatNo, room, device, matchInfo });
      } catch (error) {
        failures.push(`${seatNo}：${error.message}`);
      }
    }
    if (!matches.length) throw new Error(`所有候选座位均未匹配：${failures.join("；")}`);

    const { seatNo, room, device, matchInfo } = matches[0];
    return {
      ok: true,
      room,
      device: publicDeviceInfo(device),
      matchInfo,
      matches: matches.map((match) => ({
        seatNo: match.seatNo,
        room: match.room,
        device: publicDeviceInfo(match.device),
        matchInfo: match.matchInfo,
      })),
      message: `匹配到 ${matches.length} 个候选座位；优先使用 ${seatNo}：${room.label} / ${seatLabel(device)}，devId=${device.devId ?? device.deviceId}，字段 ${matchInfo.field}=${matchInfo.value}`,
    };
  } finally {
    if (!headless) await page.waitForTimeout(8000).catch(() => {});
    await browser.close().catch(() => {});
  }
}
