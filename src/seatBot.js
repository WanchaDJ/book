import { chromium } from "@playwright/test";

export const TARGET = {
  baseUrl: "https://tsgzw1.qdhhc.edu.cn",
  mobileReserveUrl: "https://tsgzw1.qdhhc.edu.cn/mobile.html#/ic/reserveList",
  apiBase: "https://tsgzw1.qdhhc.edu.cn/ic-web",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

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

async function clickFirstVisible(page, selectors, options = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: options.timeout || 1200 });
      await locator.click({ timeout: options.timeout || 1200 });
      return selector;
    } catch {}
  }
  return null;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 1500 });
      await locator.fill(value);
      return selector;
    } catch {}
  }
  return null;
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

async function login(page, form, log) {
  log("info", "打开图书馆预约系统登录页");
  await page.goto(TARGET.mobileReserveUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  const current = page.url();
  if (!/authserver|authcenter|login/.test(current)) {
    log("success", "当前浏览器会话已登录");
    return;
  }

  log("info", "检测到统一身份认证页面，填写账号密码");
  await page.evaluate(() => {
    document.querySelectorAll("input[readonly]").forEach((input) => input.removeAttribute("readonly"));
  });

  const accountFilled = await fillFirstVisible(
    page,
    [
      "input#username[name='username']",
      "input[name='username']",
      "input[placeholder*='学号']",
      "input[placeholder*='账号']",
      "input[placeholder*='用户']",
    ],
    form.account,
  );
  if (!accountFilled) throw new Error("没有找到账号输入框，登录页结构可能已变化");

  const passwordFilled = await fillFirstVisible(
    page,
    [
      "input#password",
      "input[name='passwordText']",
      "input[type='password']",
      "input[placeholder*='密码']",
    ],
    form.password,
  );
  if (!passwordFilled) throw new Error("没有找到密码输入框，登录页结构可能已变化");

  if (await hasActiveChallenge(page)) {
    throw new Error("登录页出现验证码或滑块，需要手动完成；本工具不会自动识别验证码");
  }

  const clicked = await clickFirstVisible(page, [
    "#login_submit",
    "a.login-btn",
    "button:has-text('登录')",
    "text=登录",
  ]);
  if (!clicked) throw new Error("没有找到登录按钮，登录页结构可能已变化");

  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);

  if (/authserver|authcenter/.test(page.url())) {
    const errorText = await page
      .locator("#showErrorTip, .form-error, .form-errorTip")
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => "");
    throw new Error(errorText ? `登录未完成：${errorText}` : "登录未完成，可能需要验证码、二次确认或账号密码错误");
  }
  log("success", "登录完成");
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
}

function normalizeDigits(value) {
  const digits = String(value ?? "").match(/\d+/g)?.join("") || "";
  return digits.replace(/^0+/, "") || digits;
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
  const values = await page
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
    .catch(() => []);

  for (const value of values) {
    const userInfo = pickUserInfo(value);
    if (userInfo) return userInfo;
  }
  return null;
}

function apiHeaders(userInfo = {}) {
  const headers = {
    accept: "application/json, text/plain, */*",
    lan: "1",
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

async function apiGet(context, userInfo, path, params, action) {
  const response = await context.request.get(`${TARGET.apiBase}/${path.replace(/^\/+/, "")}`, {
    params,
    headers: apiHeaders(userInfo),
  });
  return readApiResponse(response, action);
}

async function apiPost(context, userInfo, path, payload, action) {
  const response = await context.request.post(`${TARGET.apiBase}/${path.replace(/^\/+/, "")}`, {
    data: payload,
    headers: {
      ...apiHeaders(userInfo),
      "content-type": "application/json",
    },
  });
  return readApiResponse(response, action);
}

async function getLoggedInUserInfo(context, page, form, log) {
  let userInfo = await readUserInfoFromPage(page);
  if (userInfo) return userInfo;

  log("info", "正在从登录会话读取用户信息");
  const data = await apiGet(context, {}, "auth/userInfo", {}, "读取用户信息");
  if (data?.code !== 0 || !data.data) {
    throw new Error(data?.message || "没有从登录会话中取得用户信息");
  }

  userInfo = data.data;
  await page
    .evaluate((info) => {
      window.sessionStorage.setItem("userInfo", JSON.stringify(info));
      window.sessionStorage.setItem("isLogin", "true");
    }, userInfo)
    .catch(() => {});

  if (!userInfo.token) {
    log("warn", "已取得用户信息，但未发现 token；将依赖当前网页登录 Cookie 提交");
  }
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
  log("info", `未选择阅览区，将在 ${rooms.length} 个阅览区中查找候选座位 ${seatCandidates(form).join("、")}`);
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
      log("warn", `${room.label} 座位图读取失败：${data?.message || "接口返回异常"}`);
      continue;
    }

    const devices = collectSeatDevices(data.data);
    checked.push(`${room.label}(${devices.length})`);
    if (!samples.length) samples = devices.slice(0, 8).map(seatLabel);

    const match = devices.find((device) => seatMatchInfo(device, seatNo));
    if (match) {
      const matchInfo = seatMatchInfo(match, seatNo);
      log(
        "success",
        `在 ${room.label} 找到座位 ${seatLabel(match)}，devId=${match.devId ?? match.deviceId}，匹配字段 ${matchInfo.field}=${matchInfo.value}`,
      );
      return { room, device: match, matchInfo };
    }
  }

  const variants = seatNoVariants(seatNo).join(" / ");
  const sampleText = samples.length ? `；座位样例：${samples.join("、")}` : "";
  throw new Error(`没有在座位图数据中找到座位 ${variants}。已检查：${checked.join("，") || "无"}${sampleText}`);
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

async function submitOfficialReserve(context, page, form, segment, index, log) {
  log("info", `开始第 ${index + 1} 段：${formatDateTime(segment, "begin")} 至 ${formatDateTime(segment, "end")}`);
  log("info", "使用官网可视化座位图接口读取 devId，并通过官网预约接口提交");

  const userInfo = await getLoggedInUserInfo(context, page, form, log);
  const candidates = seatCandidates(form);
  const failures = [];
  if (!candidates.length) throw new Error("没有可用候选座位");

  for (let seatIndex = 0; seatIndex < candidates.length; seatIndex += 1) {
    const seatNo = candidates[seatIndex];
    const label = seatIndex === 0 ? "主座位" : `备选座位 ${seatIndex}`;
    log("info", `第 ${index + 1} 段尝试${label}：${seatNo}`);

    try {
      const { room, device } = await findSeatDevice(context, userInfo, form, segment, log, seatNo);
      await checkDeviceTips(context, userInfo, device, segment);

      const accNo = userInfo.accNo || userInfo.logonName || userInfo.account || form.account;
      const devId = device.devId ?? device.deviceId;
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
      if (data?.code !== 0) throw new Error(data?.message || `第 ${index + 1} 段预约失败`);

      log("success", `第 ${index + 1} 段预约提交成功：${room.label} / ${seatLabel(device)}（${label} ${seatNo}）`);
      return {
        ok: true,
        roomId: room.id,
        requestedSeat: seatNo,
        seat: seatLabel(device),
        devId,
        data,
      };
    } catch (error) {
      failures.push(`${seatNo}：${error.message}`);
      log("warn", `第 ${index + 1} 段${label} ${seatNo} 失败：${error.message}`);
    }
  }

  throw new Error(`第 ${index + 1} 段所有候选座位均预约失败：${failures.join("；")}`);
}

export async function runSeatTask(form, log) {
  const browser = await chromium.launch({
    headless: !form.visibleBrowser,
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
    await login(page, form, log);

    const results = [];
    log("info", `候选座位顺序：${seatCandidates(form).join(" → ")}`);
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
    if (form.visibleBrowser) {
      log("info", "浏览器保持打开 20 秒，方便查看结果");
      await page.waitForTimeout(20000).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

export async function previewSeatMatch(form, log) {
  const browser = await chromium.launch({
    headless: !form.visibleBrowser,
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
    await login(page, form, log);
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
        log("warn", `候选座位 ${seatNo} 匹配失败：${error.message}`);
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
    if (form.visibleBrowser) {
      log("info", "匹配检查完成，浏览器保持打开 8 秒");
      await page.waitForTimeout(8000).catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}
