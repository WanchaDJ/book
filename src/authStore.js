import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, timingSafeEqual, scryptSync } from "node:crypto";

const DATA_DIR = resolve(process.env.DATA_DIR || "data");
const USERS_FILE = resolve(process.env.USERS_FILE || `${DATA_DIR}/users.json`);

function ensureStore() {
  mkdirSync(dirname(USERS_FILE), { recursive: true });
  if (!existsSync(USERS_FILE)) writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(readFileSync(USERS_FILE, "utf8"));
    return { users: Array.isArray(data.users) ? data.users : [] };
  } catch {
    return { users: [] };
  }
}

function writeStore(store) {
  ensureStore();
  writeFileSync(USERS_FILE, JSON.stringify(store, null, 2));
}

function passwordHash(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) return false;
  const actual = Buffer.from(passwordHash(password, salt).split(":")[1], "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    initialPassword: user.initialPassword || null,
    boundStudentId: user.boundStudentId || null,
    createdAt: user.createdAt,
    boundAt: user.boundAt || null,
  };
}

export function listUsers() {
  return readStore().users.map(publicUser);
}

export function createUser(username, password) {
  const name = String(username || "").trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(name)) {
    throw new Error("账号只能包含字母、数字、下划线和横线，长度 3-32 位");
  }
  if (!password || String(password).length < 8) {
    throw new Error("密码至少 8 位");
  }

  const store = readStore();
  if (store.users.some((user) => user.username.toLowerCase() === name.toLowerCase())) {
    throw new Error(`账号 ${name} 已存在`);
  }

  const user = {
    id: randomBytes(12).toString("hex"),
    username: name,
    passwordHash: passwordHash(String(password)),
    initialPassword: String(password),
    boundStudentId: null,
    createdAt: new Date().toISOString(),
    boundAt: null,
  };
  store.users.push(user);
  writeStore(store);
  return publicUser(user);
}

export function authenticateUser(username, password) {
  const name = String(username || "").trim();
  const store = readStore();
  const user = store.users.find((item) => item.username.toLowerCase() === name.toLowerCase());
  if (!user || !verifyPassword(String(password || ""), user.passwordHash)) return null;
  return publicUser(user);
}

export function getUser(username) {
  const name = String(username || "").trim();
  const user = readStore().users.find((item) => item.username.toLowerCase() === name.toLowerCase());
  return publicUser(user);
}

export function bindStudentId(username, studentId) {
  const name = String(username || "").trim();
  const id = String(studentId || "").trim();
  if (!id) throw new Error("学号不能为空");

  const store = readStore();
  const user = store.users.find((item) => item.username.toLowerCase() === name.toLowerCase());
  if (!user) throw new Error("系统账号不存在");
  if (user.boundStudentId && user.boundStudentId !== id) {
    throw new Error(`该系统账号已绑定学号 ${user.boundStudentId}，不能修改`);
  }
  if (!user.boundStudentId) {
    user.boundStudentId = id;
    user.boundAt = new Date().toISOString();
    writeStore(store);
  }
  return publicUser(user);
}

export function deleteUser(username) {
  const name = String(username || "").trim();
  const store = readStore();
  const nextUsers = store.users.filter((item) => item.username.toLowerCase() !== name.toLowerCase());
  if (nextUsers.length === store.users.length) throw new Error("系统账号不存在");
  store.users = nextUsers;
  writeStore(store);
  return true;
}
