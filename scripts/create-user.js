#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createUser } from "../src/authStore.js";

const [, , usernameArg, passwordArg] = process.argv;
const username = usernameArg?.trim();
const password = passwordArg || randomBytes(9).toString("base64url");

if (!username) {
  console.error("用法：node scripts/create-user.js <系统账号> [密码]");
  process.exit(1);
}

try {
  const user = createUser(username, password);
  console.log("系统账号已生成：");
  console.log(`账号：${user.username}`);
  console.log(`密码：${password}`);
  console.log("第一次登录后会绑定一个学号，绑定后不能修改。");
} catch (error) {
  console.error(`生成失败：${error.message}`);
  process.exit(1);
}
