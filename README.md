# 灵魂小馆 · Fun Quiz

四款移动端趣味测评，同一仓库、同一站点，独立入口：

| 产品 | 地址 |
| --- | --- |
| 你的上一世是什么？ | `/quiz/past` |
| 你的下一世是什么？ | `/quiz/next` |
| 你是哪一种流浪猫？ | `/quiz/cat` |
| 末世来临，你会变成什么动物？ | `/quiz/end` |

每款24题，32种基础身份、96种固定变体。同一产品、同一答案、同一版本生成相同的结果内容；会话、时间、测评码不影响文学身份。问卷是趣味自我探索，未经心理测量验证。

## 当前部署：Makers + Blob

线上入口是 `cloud-functions/api/[[default]].js`，使用 Node.js 云函数与 `@edgeone/pages-blob@0.0.18`。测评码、会话、草稿、结果、分享索引与批次均保存到 Makers 的 `fun-quiz-v1` Blob 命名空间。**不再需要 Supabase、DATABASE_URL 或数据库迁移。**

按用户2026-10-11确认，接受 Blob 并发读改写带来的次数偏差。四款共用每码3次额度，普通顺序使用时成功保存结果后计1次；验证、回退、刷新、查看、分享和图片保存不扣次。并发提交可能超额、丢失额度更新或覆盖草稿；不能宣称分布式事务或严格并发3次上限。SDK的强一致读取仅降低缓存陈旧，不提供锁或条件更新。

成功结果另有独立快照，避免后续码对象覆盖使已发布结果丢失。普通重复提交读取原结果；提交失败可在原测评重试。批量生成100码支持同请求编号继续初始化，不重置已存在码。Blob没有跨对象事务；发生网络应答丢失时可能已保存，不能仅凭错误提示判断未扣次。

## Makers 配置

导入 GitHub 仓库 `ddx533534/Fun-Quiz`，根目录选仓库根目录，使用 `edgeone.json`：

- 安装：`npm ci && npm ci --prefix web`
- 构建：`npm run build`
- 静态输出：`web/dist`
- Node：22.11.0
- API：Node.js 云函数 `/api/*`，源码已提交，不依赖构建后才发现函数。
- 无备案域名：加速区域选“全球可用区（不含中国大陆）”。

在平台**服务端环境变量**中仅配置以下三项：

| 名称 | 要求 |
| --- | --- |
| `APP_SECRET` | 密码学随机生成，至少40字符，上线后保持不变 |
| `ADMIN_KEY` | 密码学随机生成，至少32字符，用于 `/admin` 登录 |
| `PUBLIC_ORIGIN` | `https://quiz.moting.com.cn`，无尾部斜杠，须是你自己的最终站点地址 |

`.env.example` 是模板，不是真实密钥。本机 `.env.production` 被Git忽略，如已生成可将里面的三项值复制到平台。不得加入 `VITE_` 前缀，不得提交密钥、用户数据或码CSV。修改平台变量后重新部署生产环境。

首次成功调用 API 后 SDK 自动创建命名空间；控制台 Blob 页面支持只读查看。不存在需要手动建数据库表的步骤。检查 `/api/health` 返回 `ok: true` 和 `storage: makers-blob`，再实际登录 `/admin` 生成100码，完整测评后检查结果与分享。配置缺失返回中文JSON 503，存储错误不暴露密钥或原始错误内容。

默认域名在大陆使用短时预览链接，不能用作永久分享地址。API与站内导航会携带预览参数，永久分享链接仍使用 `PUBLIC_ORIGIN`。请先完成自有域名的归属验证、CNAME和HTTPS；网站可以预览，但自有域名生效前复制的正式分享地址不可用。大陆各运营商及微信内浏览器仍需上线实测。

## 功能与隐私

- 答题自动保存、回退修改、刷新恢复；各款草稿独立。
- 会话HttpOnly/Secure/SameSite=Lax Cookie，写接口检查Origin与CSRF，管理权限1小时。
- HMAC索引码和会话；批次导出与分享凭据使用AES-GCM加密。结果链接不可猜测。
- 公共分享仅含文学结果，不包含答案、分数、证据、测评码或次数。拥有者可撤销。
- `/admin` 批量生成100个通用码，CSV导出24小时可用。
- 1080×1920 PNG在浏览器生成，可下载、系统分享或长按保存，无需上传图片。
- 所有API响应禁用缓存；无第三方图片或字体请求。
- 更换APP_SECRET会使旧码、会话、导出与分享凭据不可用。保留密钥与Blob数据备份。

## 本地预览

需要Node22.11+。在仓库根目录：

```powershell
npm ci
npm ci --prefix web
npm run build
npm run dev
```

打开 `http://127.0.0.1:8001`。本地以 `.blob-local/` 文件模拟Blob持久化，**不会访问云端Blob**。本地管理密钥在 `.blob-local/secrets.json` 中；如果已有旧版 `local-secrets.json`，首次启动复用其中管理密钥。所有本地数据与密钥被Git忽略。本地试用码不能直接在云端使用；上线后从云端 `/admin` 重新生成。

## 验证

```powershell
# Python仅供跨语言结果对照测试，线上不需要Python。
$env:PYTHON='.venv/Scripts/python.exe'
npm test
# 启动本地Node预览后，在web目录执行：
$env:E2E_ORIGIN='http://127.0.0.1:8001'
$env:E2E_BROWSER_PATH='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node e2e/smoke.mjs
```

Blob测试覆盖顺序3次额度、批次恢复、幂等重试、答题进度、所有权、分享投影与撤销、CSRF/Origin、限流、保存故障与快照恢复。580组答案逐项对照Python参考算法，覆盖96变体。浏览器测试覆盖四入口、手机/桌面、批量100码、回退修改、刷新恢复、PNG与匿名分享。

`api/`、Python旧API测试、Docker/Caddy部署文件保留作为数据库版参考；它们不参与当前Makers部署。旧部署研究记录只反映历史方案，现行架构以本README及Node入口为准。Blob方案设计和已验证边界见 `docs/Makers-Blob替代数据库实施记录.md`。
