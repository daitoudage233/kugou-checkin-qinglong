/*
 * cron "10 1 * * *" kgcheckin_qinglong.js
 * new Env('酷狗概念VIP签到');
 *
 * 可选的手动账号配置：
 *   KUGOU_USERINFO='123456#你的token'
 *   多账号：KUGOU_USERINFO='账号一#令牌一&账号二#令牌二'
 *
 * 推荐方式：先运行 kgcheckin_qr_login.js 扫码登录。账号会自动保存到
 * /ql/data/kugou_userinfo.json，后续签到和周日 token 刷新均无需环境变量。
 * 已保存的账号文件优先于 KUGOU_USERINFO，避免刷新后的 token 被旧变量覆盖。
 *
 * 脚本只使用 Node.js 内置模块，Node.js 16 及以上可运行。青龙存在
 * sendNotify 时会自动发送通知，不存在时只输出任务日志。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// 与上游实现一致的客户端标识。接口签名会包含 appid 和 clientver，不能随意修改。
const APP_ID = 1005;
const CLIENT_VER = 20489;

// 网络异常会重试两次；VIP 广告领取之间必须间隔 30 秒，否则接口会拒绝请求。
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [1_000, 2_000];
const VIP_CLAIM_COUNT = 8;
const VIP_CLAIM_INTERVAL_MS = 30_000;
// 青龙 /ql/data 是订阅脚本更新后仍会保留的持久化目录，账号 token 只保存在这里。
const ACCOUNT_FILE = '/ql/data/kugou_userinfo.json';

// 用户详情和 token 刷新接口使用 RSA 无填充加密，该公钥来自上游 API 实现。
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`;

/** 等待指定时长，主要用于接口重试和 VIP 连续领取的节流。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 酷狗接口签名、设备标识和 AES 临时密钥派生均使用 MD5。 */
function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

/** 日志和通知中隐藏账号、昵称等标识，避免直接输出完整敏感信息。 */
function mask(value, left = 3, right = 2) {
  const text = String(value || '');
  if (text.length <= left + right) return '*'.repeat(text.length);
  return `${text.slice(0, left)}***${text.slice(-right)}`;
}

/**
 * 以 UTC+8 计算日期和星期，避免青龙容器为 UTC 时在北京时间凌晨误判日期。
 * 返回值应始终使用 getUTC* 方法读取，因为时间已经人为加了八小时。
 */
function chinaNow() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}

/** 将 UTC+8 的 Date 对象格式化为 yyyy-mm-dd，用于日志和通知标题。 */
function chinaDate(now = chinaNow()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 校验并标准化账号配置。手动环境变量使用 "userid#token"，多账号用 "&" 分隔。
 * 仍兼容旧版 JSON，便于从先前版本平滑迁移。内部始终使用数组，以便同一任务
 * 按顺序处理多个账号。dfid 缺省时使用上游默认值 "-"。
 */
function parseAccounts(raw, source) {
  let parsed;
  const value = String(raw).trim();
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${source} 不是有效 JSON：${error.message}`);
    }
  } else {
    parsed = value.split('&').filter(Boolean).map((item, index) => {
      const separator = item.indexOf('#');
      if (separator <= 0 || separator === item.length - 1) {
        throw new Error(`${source} 的第 ${index + 1} 个账号格式错误，应为 userid#token`);
      }
      return { userid: item.slice(0, separator), token: item.slice(separator + 1) };
    });
  }

  const accounts = Array.isArray(parsed) ? parsed : [parsed];
  if (accounts.length === 0) throw new Error(`${source} 中没有账号`);

  return accounts.map((account, index) => {
    if (!account || !account.userid || !account.token) {
      throw new Error(`${source} 的第 ${index + 1} 个账号缺少 userid 或 token`);
    }
    return {
      userid: String(account.userid),
      token: String(account.token),
      dfid: account.dfid ? String(account.dfid) : '-',
    };
  });
}

/**
 * 加载账号时固定账号文件优先于环境变量：周日 token 刷新会写进该文件，下一次
 * 任务必须读取新值。首次使用可直接运行扫码脚本，通常无需配置环境变量。
 */
function loadAccounts() {
  if (fs.existsSync(ACCOUNT_FILE)) {
    return {
      accounts: parseAccounts(fs.readFileSync(ACCOUNT_FILE, 'utf8'), `文件 ${ACCOUNT_FILE}`),
      source: `文件 ${ACCOUNT_FILE}`,
    };
  }

  const userinfo = process.env.KUGOU_USERINFO;
  if (!userinfo) {
    throw new Error('未找到账号信息。请先运行 kgcheckin_qr_login.js 扫码登录，或配置 KUGOU_USERINFO。');
  }
  return {
    accounts: parseAccounts(userinfo, '环境变量 KUGOU_USERINFO'),
    source: '环境变量 KUGOU_USERINFO',
  };
}

/**
 * 将扫码或刷新后的 token 写入固定的青龙持久化文件。文件权限设为 0600，
 * 在 Linux 青龙容器内限制为当前用户可读写；Windows 会忽略该权限设置。
 */
function saveAccounts(accounts) {
  fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, `${JSON.stringify(accounts, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * 构造 Android 网关接口签名。参数键必须排序，POST 正文也必须参与签名；
 * 所以调用方先 JSON.stringify 请求体，再将同一字符串用于签名和发送。
 */
function signatureAndroid(params, body = '') {
  const secret = 'OIlwieks28dk2k092lksi2UIkp';
  const values = Object.keys(params)
    .sort()
    .map((key) => `${key}=${typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]}`)
    .join('');
  return md5(`${secret}${values}${body}${secret}`);
}

/**
 * 基于 Node 内置 http/https 的最小 JSON 请求器。
 * 不使用 axios 是为了使用户将单个文件上传到青龙后无需安装依赖。这里仅负责
 * 网络收发和 JSON 解析；HTTP 5xx 的重试策略由 kugouRequest 统一处理。
 */
function requestJson(urlString, method, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`接口返回非 JSON，HTTP ${response.statusCode}`));
          return;
        }
        resolve({ statusCode: response.statusCode || 0, data });
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`请求超时（${REQUEST_TIMEOUT_MS}ms）`)));
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

/**
 * 调用酷狗 Android 网关。
 *
 * 网关要求每个请求含有设备标识（dfid/mid/uuid）、账号凭据和签名。调用方只需
 * 指定接口路径、业务参数及请求体。本函数同时将 token 放入 query 和 Cookie，
 * 与上游本地 API 的请求格式保持一致。
 */
async function kugouRequest(account, options) {
  const dfid = account.dfid || '-';
  const mid = `${md5(dfid)}${md5(dfid).slice(0, 7)}`;
  const clienttime = Math.floor(Date.now() / 1000);
  const params = Object.assign({
    dfid,
    mid,
    uuid: md5(`${dfid}${mid}`),
    appid: APP_ID,
    clientver: CLIENT_VER,
    userid: account.userid || 0,
    clienttime,
    token: account.token || '',
  }, options.params || {});
  const body = options.data === undefined ? '' : JSON.stringify(options.data);
  params.signature = signatureAndroid(params, body);

  const url = new URL(options.path, options.baseUrl || 'https://gateway.kugou.com');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

  const headers = Object.assign({
    'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
    Cookie: `token=${account.token || ''}; userid=${account.userid || 0}; dfid=${dfid}`,
    dfid,
    clienttime: String(params.clienttime),
    mid,
    Accept: 'application/json',
  }, options.headers || {});
  if (body) {
    if (!headers['content-type'] && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  // 只重试网络错误、超时及服务端 5xx；业务错误需要立即返回给签到流程处理。
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const result = await requestJson(url.toString(), options.method || 'GET', headers, body);
      if (result.statusCode >= 500) throw new Error(`HTTP ${result.statusCode}`);
      return result.data;
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_DELAYS_MS.length) {
        console.log(`请求 ${options.path} 失败，${RETRY_DELAYS_MS[attempt] / 1000}s 后重试：${error.message}`);
        await delay(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError;
}

/**
 * 某些登录接口要求 128 字节、零填充的 RSA_NO_PADDING 数据。这里刻意不使用
 * 默认的 PKCS#1 填充，以保证请求字节格式与上游 KuGouMusicApi 相同。
 */
function rsaNoPadding(data) {
  const source = Buffer.from(JSON.stringify(data));
  if (source.length > 128) throw new Error('RSA 请求数据超出长度限制');
  const padded = Buffer.alloc(128);
  source.copy(padded);
  return crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex').toUpperCase();
}

/** token 刷新接口的固定 AES-256-CBC 加密，结果以十六进制传输。 */
function aesEncrypt(data, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('hex');
}

/** 解密 token 刷新响应中的 secu_params，并解析其中的新 token。 */
function aesDecrypt(data, temporaryKey) {
  const key = md5(temporaryKey).slice(0, 32);
  const iv = key.slice(-16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plaintext = Buffer.concat([decipher.update(data, 'hex'), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

/** 为 token 刷新生成一次性 AES 临时密钥；该密钥会通过 RSA 发送给服务器。 */
function randomKey() {
  return crypto.randomBytes(16).toString('hex').slice(0, 16);
}

/**
 * 首先验证 token 有效性并取得昵称。验证失败时不继续发送领取请求，避免把
 * 无效凭据造成的接口错误误报为签到失败。
 */
async function getUserDetail(account) {
  const clienttime = Math.floor(Date.now() / 1000);
  return kugouRequest(account, {
    path: '/v3/get_my_info',
    method: 'POST',
    params: { plat: 1 },
    data: {
      visit_time: clienttime,
      usertype: 1,
      p: rsaNoPadding({ token: account.token, clienttime }),
      userid: Number(account.userid),
    },
    headers: { 'x-router': 'usercenter.kugou.com' },
  });
}

/**
 * 周日刷新 token。接口的 p3 采用固定 AES 密钥，params 采用一次性密钥，
 * 一次性密钥再通过 RSA 加密放入 pk。成功后 secu_params 包含新 token。
 */
async function refreshToken(account) {
  const timestamp = Date.now();
  const clienttime = Math.floor(timestamp / 1000);
  const fixedKey = '90b8382a1bb4ccdcf063102053fd75b8';
  const fixedIv = 'f063102053fd75b8';
  const temporaryKey = randomKey();
  const encryptedParamsKey = md5(temporaryKey).slice(0, 32);
  const encryptedParamsIv = encryptedParamsKey.slice(-16);
  const response = await kugouRequest(account, {
    baseUrl: 'http://login.user.kugou.com',
    path: '/v5/login_by_token',
    method: 'POST',
    data: {
      dfid: account.dfid || '-',
      p3: aesEncrypt({ clienttime, token: account.token }, fixedKey, fixedIv),
      plat: 1,
      t1: 0,
      t2: 0,
      t3: 'MCwwLDAsMCwwLDAsMCwwLDA=',
      pk: rsaNoPadding({ clienttime_ms: timestamp, key: temporaryKey }),
      params: aesEncrypt({}, encryptedParamsKey, encryptedParamsIv),
      userid: account.userid,
      clienttime_ms: timestamp,
    },
    headers: { 'x-router': 'login.user.kugou.com' },
  });
  if (response.status === 1 && response.data && response.data.secu_params) {
    Object.assign(response.data, aesDecrypt(response.data.secu_params, temporaryKey));
  }
  return response;
}

/** 从不同接口返回格式中提取适合日志显示的错误信息，绝不打印完整响应。 */
function responseMessage(response) {
  if (!response || typeof response !== 'object') return '接口无有效响应';
  return response.msg || response.message || response.error || response.error_code || response.status || '未知响应';
}

/**
 * 执行一个账号的完整流程：验证账号、可选刷新 token、听歌领取、广告领取，
 * 最后查询 VIP 到期时间。调用者会捕获本函数异常，因此单个账号失败不会阻塞
 * 多账号任务中的其他账号。
 */
async function claimForAccount(account, shouldRefreshToken) {
  const accountLabel = mask(account.userid);
  const summary = { account: accountLabel, listen: '失败', vip: '失败', expiry: '未知', failed: false };

  const detail = await getUserDetail(account);
  if (!detail || !detail.data || !detail.data.nickname) {
    throw new Error(`账号验证失败：${responseMessage(detail)}`);
  }
  const nickname = mask(detail.data.nickname, 1, 1);
  summary.account = nickname;
  console.log(`\n账号 ${nickname}（${accountLabel}）开始签到`);

  // 刷新后的 token 会写入固定账号文件，因此可以安全地在周日执行刷新。
  if (shouldRefreshToken) {
    const refreshed = await refreshToken(account);
    if (refreshed.status === 1 && refreshed.data && refreshed.data.token && refreshed.data.token !== account.token) {
      account.token = String(refreshed.data.token);
      console.log(`账号 ${nickname} 的 token 已刷新`);
      summary.tokenRefreshed = true;
    } else if (refreshed.status !== 1) {
      console.log(`账号 ${nickname} 的 token 刷新失败：${responseMessage(refreshed)}`);
    }
  }

  const listen = await kugouRequest(account, {
    path: '/youth/v2/report/listen_song',
    method: 'POST',
    params: { clientver: 10566 },
    data: { mixsongid: 666075191 },
    headers: {
      'User-Agent': 'Android13-1070-10566-201-0-ReportPlaySongToServerProtocol-wifi',
      'content-type': 'application/json; charset=utf-8',
    },
  });
  if (listen.status === 1) {
    summary.listen = '成功';
  } else if (listen.error_code === 130012) {
    summary.listen = '今日已领取';
  } else {
    summary.failed = true;
    summary.listen = `失败 (${responseMessage(listen)})`;
  }
  console.log(`听歌领取：${summary.listen}`);

  // 服务端返回 30002 表示今天已达上限，是正常完成状态而不是任务失败。
  let claimed = 0;
  let reachedLimit = false;
  let vipClaimFailed = false;
  for (let index = 1; index <= VIP_CLAIM_COUNT; index += 1) {
    const now = Date.now();
    const ad = await kugouRequest(account, {
      path: '/youth/v1/ad/play_report',
      method: 'POST',
      data: { ad_id: 12307537187, play_end: now, play_start: now - 30_000 },
    });
    if (ad.status === 1) {
      claimed += 1;
      console.log(`VIP 领取：第 ${index} 次成功`);
      if (index < VIP_CLAIM_COUNT) await delay(VIP_CLAIM_INTERVAL_MS);
    } else if (ad.error_code === 30002) {
      reachedLimit = true;
      console.log('VIP 领取：今日次数已用完');
      break;
    } else {
      vipClaimFailed = true;
      summary.failed = true;
      summary.vip = `失败 (${responseMessage(ad)})`;
      console.log(`VIP 领取：${summary.vip}`);
      break;
    }
  }
  if (!vipClaimFailed) {
    summary.vip = reachedLimit && claimed === 0 ? '今日已领取完毕' : `${claimed}/${VIP_CLAIM_COUNT} 次成功`;
  }

  const vipDetail = await kugouRequest(account, {
    baseUrl: 'https://kugouvip.kugou.com',
    path: '/v1/get_union_vip',
    method: 'GET',
    params: { busi_type: 'concept' },
  });
  if (vipDetail.status === 1 && Array.isArray(vipDetail.data && vipDetail.data.busi_vip) && vipDetail.data.busi_vip.length > 0) {
    summary.expiry = vipDetail.data.busi_vip[0].vip_end_time || '未知';
  } else {
    summary.failed = true;
    summary.expiry = `获取失败 (${responseMessage(vipDetail)})`;
  }
  console.log(`概念 VIP 到期：${summary.expiry}`);
  return summary;
}

/**
 * 各青龙版本放置 sendNotify.js 的目录并不完全一致。依次尝试任务同目录、
 * 当前工作目录和默认 /ql/scripts；全部失败则返回 null，签到不受影响。
 */
function loadNotify() {
  const candidates = [
    path.join(__dirname, 'sendNotify'),
    path.join(process.cwd(), 'sendNotify'),
    '/ql/scripts/sendNotify',
  ];
  for (const candidate of candidates) {
    try {
      const notify = require(candidate);
      if (typeof notify.sendNotify === 'function') return notify.sendNotify;
    } catch {
      // 青龙版本和任务目录不同，继续尝试下一处。
    }
  }
  return null;
}

/** 主入口：按账号执行、在 token 变更后持久化、汇总日志并调用青龙通知。 */
async function main() {
  const { accounts, source } = loadAccounts();
  const now = chinaNow();
  const date = chinaDate(now);
  // getUTCDay() 的 0 代表周日。此时使用的是前面转换好的北京时间。
  const shouldRefreshToken = now.getUTCDay() === 0;
  console.log(`酷狗概念 VIP 签到，日期：${date}，账号数：${accounts.length}，配置来源：${source}`);

  const summaries = [];
  let tokenChanged = false;
  for (const account of accounts) {
    try {
      const result = await claimForAccount(account, shouldRefreshToken);
      tokenChanged = tokenChanged || Boolean(result.tokenRefreshed);
      summaries.push(result);
    } catch (error) {
      console.log(`账号 ${mask(account.userid)} 执行失败：${error.message}`);
      summaries.push({ account: mask(account.userid), listen: '异常', vip: '未执行', expiry: '未知', failed: true });
    }
  }

  // 不调用青龙 API 修改环境变量，只更新脚本专用的持久化文件。
  if (tokenChanged) {
    saveAccounts(accounts);
    console.log(`刷新后的 token 已写入 ${ACCOUNT_FILE}`);
  }

  const failures = summaries.filter((item) => item.failed).length;
  const title = `酷狗签到${failures ? '异常' : '成功'} ${date}`;
  const content = [
    `账号：${summaries.length} 个，成功：${summaries.length - failures} 个，异常：${failures} 个`,
    ...summaries.map((item) => `${item.account}\n听歌：${item.listen}\nVIP：${item.vip}\n到期：${item.expiry}`),
  ].join('\n\n');
  console.log(`\n${title}\n${content}`);

  const sendNotify = loadNotify();
  if (sendNotify) {
    try {
      await sendNotify(title, content);
    } catch (error) {
      console.log(`青龙通知发送失败：${error.message}`);
    }
  }

  // 让青龙将部分账号失败显示为失败任务，同时仍保留其他账号的完整执行结果。
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`签到脚本异常：${error.stack || error.message}`);
  process.exitCode = 1;
});
