# 酷狗概念 VIP 青龙脚本

这个仓库包含从 [develop202/kgcheckin](https://github.com/develop202/kgcheckin) 抽取并改造的青龙任务脚本。转换后的脚本没有 npm 依赖，也不会启动本地 API 服务，不需要 `npm install`，也不会在本地常驻一个 API 进程。

脚本提供每日概念 VIP 领取、二维码登录、账号密码登录、token 自动刷新和青龙通知。登录凭据统一保存在青龙持久化目录，订阅脚本更新后不会丢失。

> 本项目仅供学习和个人自动化使用。请遵守酷狗服务条款、版权要求和当地法律；不要分享账号、密码、扫码链接或 token。

## 快速开始

最简单的流程不需要设置任何环境变量：

1. 将三个 `.js` 脚本上传到青龙的 `scripts` 目录，或加入自己的订阅仓库。
2. 手动运行 `kgcheckin_qr_login.js`，在任务日志直接扫描二维码，或从青龙文件管理打开二维码图片。
3. 用酷狗 APP 扫码并确认登录。账号会自动保存到 `/ql/data/kugou_userinfo.json`。
4. 为 `kgcheckin_qinglong.js` 创建每天执行一次的定时任务。

二维码登录、账号密码登录均只应手动运行；只有签到主脚本需要定时执行。

## 文件

- `kgcheckin_qinglong.js`：每天执行的签到任务。
- `kgcheckin_qr_login.js`：生成可扫描二维码并获取账号令牌（固定等待 120 秒）。
- `kgcheckin_password_login.js`：使用账号和密码登录并保存账号令牌。
- `vendor/`：本地保留的二维码编码器源码与许可证，仅供追溯；部署时无需上传。

## 前置条件

- 青龙容器需要 Node.js 16 或更高版本。
- 容器需要可访问酷狗接口，包括 `gateway.kugou.com`、`login-user.kugou.com` 和 `kugouvip.kugou.com`。
- 默认青龙数据目录 `/ql/data` 需要可写。脚本会在其中创建账号文件。
- 脚本不依赖 axios、qrcode 或其他 npm 包；二维码编码器已内嵌在扫码脚本中。

本机已用 Node.js 进行语法检查，并用无效测试凭据验证过请求签名、接口连通和异常处理。实际领取结果需要有效账号验证。

## 青龙配置

将 `kgcheckin_qinglong.js`、`kgcheckin_qr_login.js` 和 `kgcheckin_password_login.js` 上传到青龙的 `scripts` 目录或订阅仓库。每个脚本均可单独运行；扫码脚本已内置二维码编码器，不需要 `vendor/` 目录或 `npm install`。

首次使用时，在青龙运行 `kgcheckin_qr_login.js`。日志会直接显示可扫描二维码，并同时生成 `/ql/data/kugou_login_qr.gif`。在电脑上打开青龙日志后可直接用酷狗 APP 扫描，或者在青龙文件管理中下载/预览该 GIF 图片后扫码。

运行 `kgcheckin_qr_login.js` 后，账号信息会自动保存到 `/ql/data/kugou_userinfo.json`。签到脚本会读取该文件，且每周日自动刷新并保存 token，因此通常无需设置任何环境变量。

二维码登录脚本会每 3 秒轮询一次授权状态，最多等待 120 秒。二维码过期、超时或未在 APP 中确认时，重新手动运行脚本即可。二维码图片会被下一次运行覆盖，过期图片不可继续使用。登录成功时，日志只显示脱敏后的账号，不会显示 token。

也可使用账号密码登录。设置唯一环境变量后，运行 `kgcheckin_password_login.js`：

```text
KUGOU_LOGIN=账号#密码
```

登录成功后同样会写入 `/ql/data/kugou_userinfo.json`。该变量包含密码，建议仅在登录任务运行期间启用或在登录完成后删除。酷狗账户若需要验证码、设备验证等安全校验，请使用扫码登录。

`KUGOU_LOGIN` 按第一个 `#` 分割，所以密码本身可以包含 `#`。密码登录脚本一次登录一个账号；要添加多个账号，可分别修改变量后手动运行多次。若连续失败，不要高频重试，应改用二维码登录。

若已自行取得 token、不使用扫码脚本，只需设置唯一可选变量：

```text
名称：KUGOU_USERINFO
值：123456#你的令牌
```

多个账号使用 `&` 分隔：

```text
账号一#令牌一&账号二#令牌二
```

旧版 JSON 格式仍可读取，供已有配置迁移使用。

### 账号文件优先级

账号文件 `/ql/data/kugou_userinfo.json` 的优先级高于 `KUGOU_USERINFO`。扫码或密码登录成功后，之后的签到会一直使用文件中的最新 token，周日刷新也会写回同一文件。

若已修改 `KUGOU_USERINFO`、但任务仍使用旧账号，说明账号文件已经存在。确认无误后删除 `/ql/data/kugou_userinfo.json`，再运行签到任务，脚本才会重新读取环境变量。不要手动编辑 token，除非已确认新值有效。

多账号保存在账号文件的同一个 JSON 数组中。重新登录已有账号时只更新对应 `userid` 的 token；登录新账号时会保留旧账号并追加新账号。

## 定时任务

只为 `kgcheckin_qinglong.js` 创建定时任务。建议每天北京时间 `01:10` 执行：

```cron
10 1 * * *
```

一次签到按以下顺序执行：

1. 从账号文件加载账号；文件不存在时才读取 `KUGOU_USERINFO`。
2. 验证每个账号的 token 是否有效。
3. 领取听歌奖励。
4. 最多领取 8 次 VIP，每次成功领取后间隔 30 秒。
5. 查询概念 VIP 到期时间并汇总结果。
6. 每周日刷新 token，刷新成功后回写账号文件。

单账号完整运行可能需要数分钟，主要是 VIP 多次领取的 30 秒间隔导致。不要设置为高频任务；当天已领取的项目会在日志中显示为已领取或已达上限。

## 账号文件

登录和刷新共用的文件路径为：

```text
/ql/data/kugou_userinfo.json
```

文件内容为 JSON 数组，示例：

```json
[
  {
    "userid": "123456",
    "token": "example-token",
    "dfid": "-"
  }
]
```

该文件包含可用于登录的 token。请勿上传、分享、截图或提交到 Git 仓库。

## 通知

脚本会自动尝试加载青龙内置的 `sendNotify`。已配置青龙通知变量时，签到结果将通过现有渠道发送；找不到通知模块时仍会正常签到并在任务日志输出结果。

通知和日志会给出每个账号的听歌领取状态、VIP 领取次数、VIP 到期时间和异常信息。任一账号异常时，任务最终会以失败状态结束，便于在青龙中发现问题；其余账号仍会继续执行。

## 注意事项

- 扫码链接、账号密码和令牌均为敏感信息。账号 token 保存在 `/ql/data/kugou_userinfo.json`，请勿将该文件上传、分享或提交至仓库。
- 青龙容器需使用 Node.js 16 或更高版本，并能访问酷狗接口。
- 本项目仅供学习和个人自动化使用，请遵守酷狗服务条款和当地法律。

## 常见问题

### 提示“未找到账号信息”

先运行 `kgcheckin_qr_login.js` 完成扫码登录，或配置 `KUGOU_USERINFO`。同时检查 `/ql/data/kugou_userinfo.json` 是否存在且为有效 JSON。

### 二维码超时或失效

二维码有效时间有限。重新运行二维码登录脚本，在日志中直接扫描二维码，或在文件管理中打开新生成的 `/ql/data/kugou_login_qr.gif`，随后在 APP 内确认登录。不要把二维码内容当作普通网页链接打开。

### 密码登录失败

确认变量格式为 `账号#密码`，且没有额外引号或换行。若酷狗要求短信验证码、图形验证码、异地或设备验证，使用二维码登录，不要重复尝试密码登录。

### token 失效或账号验证失败

重新执行二维码或密码登录。新 token 会自动覆盖账号文件中相同 `userid` 的旧 token。

### 设置了环境变量但没有生效

账号文件的优先级更高。请先检查或删除 `/ql/data/kugou_userinfo.json`，然后再使用 `KUGOU_USERINFO`。

### 没有收到通知

通知功能依赖青龙现有的 `sendNotify` 模块和通知渠道配置。即使通知未发送，签到结果仍会完整写入任务日志。

## 上游来源与许可证

这个仓库不是一份单一的原创代码，各部分来源如下：

| 部分 | 来源 | 许可证 |
| --- | --- | --- |
| 签到流程 | [develop202/kgcheckin](https://github.com/develop202/kgcheckin) | **未声明** |
| 接口实现（签名算法、客户端标识、RSA 公钥） | [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) | MIT，Copyright (c) 2023 MakcRe |
| 内嵌二维码编码器 | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) v2.0.4 | MIT，Copyright (c) 2009 Kazuhiko Arase |
| 青龙适配、凭据持久化、二维码本地渲染、通知与日志 | 本仓库 | — |

内嵌的二维码编码器以 gzip + base64 的形式压缩在 `kgcheckin_qr_login.js` 里，为的是让脚本
能被单独上传到青龙、不依赖 `npm install`。**原始的 MIT 版权声明完整保留在压缩内容中**，
gunzip 之后开头就是那段声明；`vendor/` 另外存了一份可读源码备查。

签到流程的上游 `develop202/kgcheckin` **没有声明任何开源许可证**。所以严格来说，这个仓库
属于「在原作者未明确授权的情况下发布的衍生作品」。这里保留了完整署名和上游链接，如果
原作者认为不妥，请联系删除；上游后续补上许可证的话，这里会同步更新。
