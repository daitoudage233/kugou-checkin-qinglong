/*
 * new Env('酷狗扫码登录');
 *
 * 运行流程：脚本从接口申请一次性二维码密钥，在日志输出扫码页面链接，并持续
 * 轮询授权状态。用电脑浏览器打开链接，再用酷狗 APP 扫码并确认登录。
 *
 * 登录成功后，账号 token 自动写入 /ql/data/kugou_userinfo.json。每日签到脚本会
 * 自动读取该文件，因此首次登录和后续签到均不需要手动配置环境变量。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

// qrcode-generator v2.0.4（MIT，Kazuhiko Arase）压缩内嵌在本文件中，使脚本可被
// 单独上传到青龙。二维码仅在本地生成，不会把短期有效的登录内容发送给第三方。
const EMBEDDED_QR_GENERATOR = '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';

function loadQrGenerator() {
  const source = zlib.gunzipSync(Buffer.from(EMBEDDED_QR_GENERATOR, 'base64')).toString('utf8');
  const embeddedModule = { exports: {} };
  Function('module', 'exports', source)(embeddedModule, embeddedModule.exports);
  return embeddedModule.exports;
}

const qrcode = loadQrGenerator();

// 二维码接口同样要求客户端标识和签名，常量与上游 KuGouMusicApi 保持一致。
const APP_ID = 1005;
const CLIENT_VER = 20489;
const SRC_APP_ID = 2919;
const REQUEST_TIMEOUT_MS = 15_000;
// 与签到脚本使用同一份青龙持久化账号文件。
const ACCOUNT_FILE = '/ql/data/kugou_userinfo.json';
// 每次新建二维码会覆盖该文件；二维码过期后必须重新运行脚本生成新文件。
const QR_IMAGE_FILE = '/ql/data/kugou_login_qr.gif';

/** 生成二维码接口 Web 签名和设备标识所需的 MD5 值。 */
function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

/** 二维码授权状态每三秒查询一次，此函数提供不阻塞事件循环的等待。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 仅在成功保存提示中显示脱敏后的 userid，避免普通日志泄露账号标识。 */
function mask(value) {
  const text = String(value || '');
  return text.length <= 5 ? '*'.repeat(text.length) : `${text.slice(0, 3)}***${text.slice(-2)}`;
}

/**
 * 二维码登录使用 Web 签名，与主签到脚本的 Android 签名算法不同。必须先按
 * 字符串排序 "key=value" 条目再计算 MD5，否则服务端会拒绝请求。
 */
function signatureWeb(params) {
  const secret = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  const values = Object.keys(params).map((key) => `${key}=${params[key]}`).sort().join('');
  return md5(`${secret}${values}${secret}`);
}

/**
 * 执行 GET 请求并解析 JSON。扫码接口均为 HTTPS GET；若超时、网络错误或响应
 * 不是 JSON，Promise 会拒绝，主入口将以非零退出码结束任务。
 */
function requestJson(urlString) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const request = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
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
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('请求二维码接口超时')));
    request.once('error', reject);
    request.end();
  });
}

/**
 * 为二维码接口补齐默认设备参数和 Web 签名。extraParams 可覆盖默认 appid，
 * 这是获取二维码密钥时必须传入 appid=1001 的原因。
 */
async function kugouWebRequest(endpoint, extraParams) {
  const dfid = '-';
  const mid = `${md5(dfid)}${md5(dfid).slice(0, 7)}`;
  const params = Object.assign({
    dfid,
    mid,
    uuid: md5(`${dfid}${mid}`),
    appid: APP_ID,
    clientver: CLIENT_VER,
    userid: 0,
    clienttime: Math.floor(Date.now() / 1000),
  }, extraParams);
  params.signature = signatureWeb(params);
  const url = new URL(endpoint);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return requestJson(url.toString());
}

/**
 * 将扫码得到的账号写入持久化文件。同一 userid 已存在时只更新 token，保证
 * 多账号文件不会因某个账号重新登录而丢失；新账号则追加到数组末尾。账号文件
 * 使用固定路径，用户无需记忆或配置文件路径。
 */
function updateFile(userinfoFile, loginUser) {
  let accounts = [];
  if (fs.existsSync(userinfoFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(userinfoFile, 'utf8'));
      accounts = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new Error(`无法解析已有账号文件：${userinfoFile}`);
    }
  }
  const existing = accounts.find((account) => String(account.userid) === String(loginUser.userid));
  if (existing) Object.assign(existing, loginUser);
  else accounts.push(loginUser);
  fs.mkdirSync(path.dirname(userinfoFile), { recursive: true });
  fs.writeFileSync(userinfoFile, `${JSON.stringify(accounts, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * 把二维码矩阵输出为日志中的黑白字符。请在电脑上打开青龙日志，用手机酷狗 APP
 * 扫描这块图案；双宽字符使终端中的单元格接近正方形，便于识别。
 */
function printTerminalQr(qr) {
  const margin = 2;
  const moduleCount = qr.getModuleCount();
  const lines = [];
  for (let row = -margin; row < moduleCount + margin; row += 1) {
    let line = '';
    for (let col = -margin; col < moduleCount + margin; col += 1) {
      const isDark = row >= 0 && row < moduleCount && col >= 0 && col < moduleCount && qr.isDark(row, col);
      line += isDark ? '██' : '  ';
    }
    lines.push(line);
  }
  console.log(lines.join('\n'));
}

/**
 * 生成标准 GIF 图片，供无法直接扫描日志时在青龙文件管理中下载或预览。二维码
 * 内容仅在本地编码，生成图片不依赖任何外部服务。createDataURL 返回 base64 GIF。
 */
function saveQrImage(qr) {
  const dataUrl = qr.createDataURL(8, 16);
  const separator = dataUrl.indexOf(',');
  if (separator === -1) throw new Error('二维码图片编码失败');
  fs.mkdirSync(path.dirname(QR_IMAGE_FILE), { recursive: true });
  fs.writeFileSync(QR_IMAGE_FILE, Buffer.from(dataUrl.slice(separator + 1), 'base64'), { mode: 0o600 });
}

/**
 * 主入口：申请二维码，输出可在浏览器打开的链接，再轮询状态。
 * 状态 1 表示等待扫码，2 表示已扫码待确认，4 表示登录成功，0 表示已过期。
 */
async function main() {
  const keyResult = await kugouWebRequest('https://login-user.kugou.com/v2/qrcode', {
    appid: 1001,
    type: 1,
    plat: 4,
    qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APP_ID}&`,
    srcappid: SRC_APP_ID,
  });
  // qrKey 是服务端返回的一次性登录密钥；不要命名为 qrcode，以免覆盖上方的编码器函数。
  const qrKey = keyResult && keyResult.data && keyResult.data.qrcode;
  if (keyResult.status !== 1 || !qrKey) throw new Error(`获取二维码失败：${keyResult && (keyResult.msg || keyResult.error_code || keyResult.status)}`);

  // 这里的 H5 地址是二维码的编码内容，直接在浏览器打开会触发客户端下载，
  // 因此必须把它渲染成二维码后交给酷狗 APP 扫描，不能再将其作为普通链接输出。
  const loginUrl = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(qrKey)}`;
  const qr = qrcode(0, 'M');
  qr.addData(loginUrl);
  qr.make();
  saveQrImage(qr);
  console.log(`二维码图片已保存至 ${QR_IMAGE_FILE}。可在青龙文件管理中下载或预览后扫码。`);
  console.log('也可以直接在电脑屏幕上用酷狗 APP 扫描下方二维码：');
  printTerminalQr(qr);
  // 二维码通常两分钟左右过期，因此固定等待两分钟，避免额外环境变量和频繁创建二维码。
  const timeoutSeconds = 120;
  const endAt = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < endAt) {
    const result = await kugouWebRequest('https://login-user.kugou.com/v2/get_userinfo_qrcode', {
      plat: 4,
      appid: APP_ID,
      srcappid: SRC_APP_ID,
      qrcode: qrKey,
    });
    const status = result && result.data && result.data.status;
    if (status === 4 && result.data.token && result.data.userid) {
      const loginUser = { userid: String(result.data.userid), token: String(result.data.token) };
      updateFile(ACCOUNT_FILE, loginUser);
      console.log(`登录成功，账号 ${mask(loginUser.userid)} 已保存至 ${ACCOUNT_FILE}`);
      return;
    }
    if (status === 0) throw new Error('二维码已过期，请重新运行登录脚本');
    if (status === 2) console.log('已扫码，等待在酷狗 APP 中确认登录...');
    await delay(3_000);
  }
  throw new Error(`等待扫码登录超时（${timeoutSeconds} 秒）`);
}

main().catch((error) => {
  console.error(`扫码登录失败：${error.message}`);
  process.exitCode = 1;
});
