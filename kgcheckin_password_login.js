/*
 * new Env('酷狗账号密码登录');
 *
 * 唯一必填环境变量：
 *   KUGOU_LOGIN='账号#密码'
 *
 * 账号可使用酷狗支持的手机号或邮箱。分隔符只取第一个 #，因此密码中可以包含 #。
 * 登录成功后，脚本会把 userid 和 token 写入 /ql/data/kugou_userinfo.json，签到
 * 脚本会自动读取这个文件。密码和 token 不会输出到任务日志。
 *
 * 若酷狗对账号启用了验证码、设备验证或其他安全限制，密码登录可能被拒绝；此时
 * 请改用 kgcheckin_qr_login.js 扫码登录。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

// 与上游 KuGouMusicApi 一致的 Android 客户端身份，参与每次接口签名。
const APP_ID = 1005;
const CLIENT_VER = 20489;
const REQUEST_TIMEOUT_MS = 15_000;
const ACCOUNT_FILE = '/ql/data/kugou_userinfo.json';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`;

function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function mask(value) {
  const text = String(value || '');
  return text.length <= 5 ? '*'.repeat(text.length) : `${text.slice(0, 3)}***${text.slice(-2)}`;
}

/**
 * 解析唯一环境变量。使用第一个 # 分割，允许用户密码自身含有 #；不支持用该
 * 脚本批量登录多个账号，多个账号请分别运行一次登录任务。
 */
function loadCredential() {
  const raw = process.env.KUGOU_LOGIN;
  if (!raw) throw new Error('未配置 KUGOU_LOGIN，格式应为 账号#密码');
  const separator = raw.indexOf('#');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error('KUGOU_LOGIN 格式错误，应为 账号#密码');
  }
  return { username: raw.slice(0, separator), password: raw.slice(separator + 1) };
}

/** Android 网关签名：所有 query 参数排序后，连同 JSON 请求体参与 MD5。 */
function signatureAndroid(params, body) {
  const secret = 'OIlwieks28dk2k092lksi2UIkp';
  const values = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('');
  return md5(`${secret}${values}${body}${secret}`);
}

/**
 * 使用 Node 内置 https 发送 JSON 请求。密码仅存在于加密后的请求体中，日志不会
 * 记录 URL、请求头或请求体，从而避免任务日志泄露凭据。
 */
function requestJson(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const request = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`接口返回非 JSON，HTTP ${response.statusCode}`));
        }
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('密码登录请求超时')));
    request.once('error', reject);
    request.write(body);
    request.end();
  });
}

/**
 * 对登录端点构造默认 Android 设备参数和签名。此时尚未取得 token，userid 固定为 0。
 */
async function kugouLoginRequest(data) {
  const dfid = '-';
  const md5Dfid = md5(dfid);
  const mid = `${md5Dfid}${md5Dfid.slice(0, 7)}`;
  const params = {
    dfid,
    mid,
    uuid: md5(`${dfid}${mid}`),
    appid: APP_ID,
    clientver: CLIENT_VER,
    userid: 0,
    clienttime: Math.floor(Date.now() / 1000),
  };
  const body = JSON.stringify(data);
  params.signature = signatureAndroid(params, body);

  const url = new URL('https://gateway.kugou.com/v9/login_by_pwd');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return requestJson(url.toString(), {
    'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-router': 'login.user.kugou.com',
    dfid,
    mid,
    clienttime: String(params.clienttime),
    Accept: 'application/json',
  }, body);
}

/**
 * 上游登录协议要求密码数据使用随机 AES-256-CBC 密钥加密。随机字符串经 MD5
 * 派生为实际 AES key 与 IV；原始随机字符串会由 rsaNoPadding 加密后传给服务端。
 */
function encryptLoginParams(data) {
  const temporaryKey = crypto.randomBytes(16).toString('hex').slice(0, 16);
  const key = md5(temporaryKey).slice(0, 32);
  const iv = key.slice(-16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]).toString('hex');
  return { temporaryKey, encrypted };
}

/**
 * 登录端点要求 128 字节的 RSA_NO_PADDING 数据。使用默认 RSA 填充会使服务器无法
 * 还原 AES 临时密钥，因此这里必须与上游实现保持相同的零填充格式。
 */
function rsaNoPadding(data) {
  const source = Buffer.from(JSON.stringify(data));
  if (source.length > 128) throw new Error('RSA 请求数据超出长度限制');
  const padded = Buffer.alloc(128);
  source.copy(padded);
  return crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex').toUpperCase();
}

/** 使用登录时生成的临时密钥解密服务器返回的 secu_params。 */
function decryptSecureParams(encrypted, temporaryKey) {
  const key = md5(temporaryKey).slice(0, 32);
  const iv = key.slice(-16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plaintext = Buffer.concat([decipher.update(encrypted, 'hex'), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

/**
 * 合并账号到签到脚本使用的持久化文件。同一 userid 的旧 token 会被覆盖，新账号
 * 则追加。整个文件写入后仅当前容器用户可读写（Linux 下的 mode 0600）。
 */
function saveAccount(loginUser) {
  let accounts = [];
  if (fs.existsSync(ACCOUNT_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
      accounts = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new Error(`无法解析已有账号文件：${ACCOUNT_FILE}`);
    }
  }
  const existing = accounts.find((account) => String(account.userid) === loginUser.userid);
  if (existing) Object.assign(existing, loginUser);
  else accounts.push(loginUser);
  fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, `${JSON.stringify(accounts, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function responseMessage(response) {
  if (!response || typeof response !== 'object') return '接口无有效响应';
  return response.msg || response.message || response.error || response.error_code || response.status || '未知响应';
}

async function main() {
  const { username, password } = loadCredential();
  const timestamp = Date.now();
  const encrypted = encryptLoginParams({ pwd: password, code: '', clienttime_ms: timestamp });

  // password 在 params 中以 AES 密文出现，服务端用 pk 解出的临时密钥进行解密。
  const result = await kugouLoginRequest({
    plat: 1,
    support_multi: 1,
    clienttime_ms: timestamp,
    t1: 0,
    t2: 0,
    t3: 'MCwwLDAsMCwwLDAsMCwwLDA=',
    username,
    params: encrypted.encrypted,
    pk: rsaNoPadding({ clienttime_ms: timestamp, key: encrypted.temporaryKey }),
  });

  if (result.status !== 1 || !result.data) {
    throw new Error(`账号密码登录失败：${responseMessage(result)}`);
  }
  const secureData = result.data.secu_params
    ? decryptSecureParams(result.data.secu_params, encrypted.temporaryKey)
    : result.data;
  const token = secureData.token || result.data.token;
  const userid = secureData.userid || result.data.userid;
  if (!token || !userid) throw new Error('登录响应缺少 userid 或 token');

  saveAccount({ userid: String(userid), token: String(token) });
  console.log(`账号 ${mask(username)} 登录成功，已保存至 ${ACCOUNT_FILE}`);
}

main().catch((error) => {
  console.error(`账号密码登录失败：${error.message}`);
  process.exitCode = 1;
});
