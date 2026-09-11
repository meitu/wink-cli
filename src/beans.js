"use strict";

const PAYMENT_URLS = Object.freeze({
  pre: "https://pre.wink.cn/workspace?showPayment=1",
  beta: "https://beta.wink.cn/workspace?showPayment=1",
  release: "https://wink.cn/workspace?showPayment=1",
});
const POLL_MS = 5000;
const TIMEOUT_MS = 300000;

function isInsufficientBeans(value) {
  return Number(value?.code ?? value?.extCode) === 1999 &&
    typeof value?.message === "string" && value.message.includes("美豆不足");
}

/** One recharge deadline per file, including repeated submit rejections. */
function createRechargeHandler({ client, env, openBrowser, report, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let deadline, opened = false;
  const url = PAYMENT_URLS[env];
  function timedOut(lastError) {
    return new Error(`等待美豆充值超时（300 秒）${lastError ? `；最后查询错误：${lastError}` : ""}。充值后请重新运行；充值链接 ${url}`);
  }
  async function readAmount() {
    const remaining = deadline - now();
    if (remaining <= 0) throw timedOut();
    const response = await client.remainAmountInfo({ requestTimeout: Math.min(30, remaining / 1000), isTest: env === "pre" ? 1 : 0 });
    if (now() >= deadline) throw timedOut();
    if (response?.code !== 0) {
      throw new Error(`${response?.message || "余额查询失败"}（code=${response?.code ?? "未知"}）`);
    }
    const amount = response?.data?.total_amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error("余额接口未返回有效的 total_amount");
    }
    return amount;
  }
  return async rejection => {
    if (!url) throw new Error("美豆不足：自定义接口未配置充值环境，请充值后重新运行");
    if (deadline === undefined) deadline = now() + TIMEOUT_MS;
    if (now() >= deadline) throw timedOut();
    // A new explicit submit rejection gets a new baseline. Reusing the original
    // baseline would repeatedly submit on the same insufficient top-up.
    let baseline;
    try {
      baseline = await readAmount();
    } catch (error) {
      const original = rejection?.message || "美豆不足";
      const code = rejection?.code ?? rejection?.extCode;
      const failure = new Error(`${original}${rejection?.code != null ? `（code=${code}）` : ""}；无法获取充值前余额，未启动充值轮询：${error.message}。可手动充值后重新运行；充值链接 ${url}`);
      failure.extCode = code;
      failure.cause = error;
      throw failure;
    }
    report(`美豆不足，已记录当前美豆 ${baseline}，请在浏览器购买美豆；充值链接 ${url}`);
    if (!opened) {
      openBrowser(url);
      opened = true;
    }
    let lastError;
    while (now() < deadline) {
      await sleep(Math.min(POLL_MS, deadline - now()));
      if (now() >= deadline) break;
      let amount;
      try {
        amount = await readAmount();
      } catch (error) {
        lastError = error.message;
        report(`余额查询失败，继续等待充值：${lastError}；充值链接 ${url}`);
        continue;
      }
      if (now() >= deadline) break;
      lastError = undefined;
      if (amount > baseline) {
        report(`美豆已从 ${baseline} 增加到 ${amount}，继续投递`);
        return true;
      }
      report(`当前美豆 ${amount}，充值前 ${baseline}，等待余额增加；剩余 ${Math.ceil((deadline - now()) / 1000)} 秒；充值链接 ${url}`);
    }
    throw timedOut(lastError);
  };
}

module.exports = { PAYMENT_URLS, isInsufficientBeans, createRechargeHandler };
