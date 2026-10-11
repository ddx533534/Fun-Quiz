# 灵魂小馆 · Fun Quiz

四款移动端趣味测评：上一世、下一世、流浪猫、末世动物。每款24题，结果库含32种基础身份、96种固定变体。答案相同且版本相同，结果内容相同。

## 已实现

- 每个测评码绑定一款测评，可成功生成3次结果；验证、回退、刷新、查看和分享不扣次。
- 自动保存答案、返回上一题修改、刷新恢复；草稿版本冲突检测。
- PostgreSQL行锁、开始预留、原子保存与扣次、重复提交返回已有结果。
- 长随机分享链接；公开页不包含原始答案、选项证据、分数、测评码或额度；可撤销分享。
- 1080×1920 PNG结果卡、系统分享/下载/长按保存，以及结果链接复制。
- `/admin` 管理室：密钥登录，一次生成100码，重复请求不重复生成，24小时内加密导出CSV。
- 无第三方字体或图片请求。生产环境必须使用PostgreSQL、HTTPS和服务端密钥。

问卷是文学化自我探索；尚未经心理测量验证，不能宣称科学诊断、真实前世或预测。

## 本地运行

需要Python 3.12、Node 22/24。在仓库根目录：

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r api/requirements.txt
npm ci --prefix web
npm run build --prefix web
.venv/Scripts/python.exe -m api.migrate
$env:PUBLIC_ORIGIN='http://127.0.0.1:8000'
.venv/Scripts/python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

打开 `http://127.0.0.1:8000`。本地首次运行生成被Git忽略的 `local-secrets.json`，其中 `admin` 是本地管理密钥；在本机读取后输入 `/admin` 即可。不要将这个文件提交到仓库或发送聊天。

开发热更新：另开终端运行 `npm run dev --prefix web`，同时把后端 `PUBLIC_ORIGIN` 设置为 `http://127.0.0.1:5173`，两个地址必须一致。

SQLite只用于本地预览；生产启动会拒绝SQLite。生产数据库迁移用 `python -m api.migrate`，不要在每个函数请求中运行迁移。

## Supabase / PostgreSQL

服务器通过 `DATABASE_URL` 直连PostgreSQL，不向浏览器暴露数据库密码或service-role key。可接Supabase官方云、自托管Supabase，或提供可达PostgreSQL连接地址的CloudBase环境。不要把HTTP API地址填成数据库连接串。

复制 `.env.example` 后用真实信息替换。容器通过 `env_file` 注入；CLI用 `uvicorn --env-file .env`。`APP_SECRET` 至少40字符、`ADMIN_KEY` 至少32字符，均用密码学随机数生成。`PUBLIC_ORIGIN` 必须是最终HTTPS站点地址。

迁移启用私有表RLS并撤销 `anon` / `authenticated` 表访问。当前后端使用表拥有者连接；若配置独立运行角色，需要配置受控数据库权限和相应RLS策略，并实测，不能直接换成前端角色。当前管理端使用单个服务端密钥，而非原方案的Supabase Auth管理员名单；多管理员Auth接入是后续扩展。

`APP_SECRET` 用于码HMAC与导出/分享链接加密。上线后不得随意更换；更换会使原码和链接不可用。备份数据库和密钥，不能只备份其中一个。

## Makers 免费试运行

仓库已包含 `edgeone.json` 和Python函数打包脚本。项目根目录选仓库根目录，安装与构建配置由该文件指定；构建后生成的 `cloud-functions/` 是部署产物，未纳入Git。

- 构建：`npm ci --prefix web`、`npm run build --prefix web`、`node scripts/build-makers.mjs`。
- 输出：`web/dist`；API入口：`cloud-functions/api/index.py`。
- 平台环境变量：`APP_ENV=production`、`DATABASE_URL`、`APP_SECRET`、`ADMIN_KEY`、`PUBLIC_ORIGIN`。
- 先迁移数据库，再部署函数，验证 `/api/health`、Cookie、CSV、并发扣次和分享路由。
- CloudBase是否允许所选Makers运行区域直连、连接配额和白名单，需要创建环境后核实；目前没有实云联调。

**大陆长期访问需要自有域名。** Makers默认项目/部署域名在大陆使用3小时预览链接；选择“全球可用区（不含中国大陆）”并绑定自有域名，按平台规则可不做ICP备案。不能把短时预览地址当永久分享域名。详见 [官方域名说明](https://cloud.tencent.com/document/product/1552/127403)。

Makers托管可用免费套餐；CloudBase免费环境有额度及续期条件。实际资源价格、开通权限、到期策略以控制台为准。本站未开通任何付费资源，也尚无公网正式地址。

## 香港服务器备用部署

构建 `Dockerfile`，用 `compose.yaml` 运行；先执行数据库迁移。Caddy配置在 `deploy/Caddyfile`，将示例域名改为自己的域名。API端口仅绑定本机，由HTTPS反向代理访问。当前禁用请求URL日志，避免分享令牌进入访问日志。

## 验证

```powershell
.venv/Scripts/python.exe -m pytest tests -q
# 使用专用测试库；测试会删除 quiz_* 表！不要填生产库。
$env:TEST_DATABASE_URL='postgresql+psycopg://quiz_test@127.0.0.1:55432/quiz_test'
.venv/Scripts/python.exe -m pytest tests -q
```

`tests/test_api.py` 覆盖额度/幂等/所有权/草稿冲突/失效预留/并发/故障回滚；`test_engine.py` 覆盖96变体和6859种ABC分数组合；`test_makers.py` 检查本地ASGI前缀适配。GitHub Actions使用独立PostgreSQL 17测试服务。

浏览器流程检查：先启动本地站点，在 `web` 运行 `node e2e/smoke.mjs`。可用 `E2E_BROWSER_PATH` 指定本机Edge，或安装Playwright Chromium。测试会在本地数据库生成100码并消耗一个码的一次机会，不应指向生产站点。截图和PNG保存在被忽略的 `test-artifacts/`。

尚待实测：Makers云端打包、CloudBase/Supabase实际数据库网络、域名绑定，以及大陆多运营商和微信内置浏览器的访问/保存行为。
