# 资源下发使用教程（cdnapi）

适用版本：Sky 0.35.1。读完这一篇可以独立完成：

1. 首次把 cdnapi 接到游戏服；
2. 下发一次资源更新（覆盖 / 新增）；
3. 在客户端和 CDN 两侧确认真的生效；
4. 回滚与常见故障排查。

---

## 0. 先理解 30 秒

```
游戏服 ──POST /token (X-API-Key)──▶ cdnapi ──签发 token──┐
   │  ◀──────── { token, expires_at } ──────────────────┘
   └─ 返回 { host, prefix, token } 给客户端   ← host/prefix 来自游戏服配置
客户端 ──POST https://<host>/manifest─────────────▶ cdnapi
       ──GET  https://<host>/resources/<sha1>────▶ cdnapi
```

- **manifest 是「文件名 → SHA-1(文件内容)」的索引**。客户端用文件名（严格区分大小写）找块。
- 客户端只下载「新清单里有、本地没有或内容不一致」的块，块按 SHA-1 存本地。
- **只有同名文件才算覆盖**。往清单里加一个游戏从来不加载的新名字，不会改变游戏表现。
- `buildCL` 决定下次启动用哪份清单（缓存清单必须**大于** ROM 清单的 buildCL）。
- `resourceHash` 决定「这次要不要同步」；清单内容不变时客户端直接跳过。
- 客户端每次会话启动时同步一次；**改完内容要重启 cdnapi，客户端要重开**。

---

## 1. 首次接入（一次性）

### 1.1 目录

```
cdnapi/
  config/config.yml
  data/base/win/resource.manifest   ← 每个平台一份 ROM 清单（win / android / ...）
  content/                          ← 共享的自定义资源（不分平台）
```

### 1.2 复制 ROM 清单

Windows Steam 默认路径：

```
<Steam>/steamapps/common/Sky Children of the Light/data/assets/initial/Data/Manifests/win/resource.manifest
```

```bash
mkdir -p cdnapi/data/base/win
cp "<Steam>/steamapps/common/Sky Children of the Light/data/assets/initial/Data/Manifests/win/resource.manifest" \
   cdnapi/data/base/win/resource.manifest
# 其它平台同理：cdnapi/data/base/android/resource.manifest ...
```

> 复制一份，不要直接指向游戏目录：游戏更新会替换那份文件，而 base 应该是你发布时的基线。
> 游戏大版本更新后，重新复制一次即可（`buildCL` 会自动跟着抬高）。
> 没有对应 base 的平台会回落到 `manifest.defaultPlatform`。

### 1.3 cdnapi 配置

`cdnapi/config/config.yml`：

```yaml
cdn:
  prefix: ""                       # 可选，原样作为 X-CDN-Prefix
  tokenSecret: "<随机 32+ 字符>"    # 只在 cdnapi，用来签发/校验 token
  tokenTtlSeconds: 86400
  env: "Beta"
  apiKey: "<随机串>"               # 与游戏服的 cdn.apiKey 相同

manifest:
  # 每个平台一份 ROM 基线：<base>/<platform>/resource.manifest
  base: "./data/base"
  # token 里没有 platform（旧游戏服）或平台没有 base 时用它
  defaultPlatform: "win"
  # 额外平台；留空 = 自动发现 data/base/<platform>/
  platforms: []
  content: "./content"
```

> cdnapi 不需要知道自己的公网域名；`host` 在游戏服配置里。

### 1.4 游戏服配置

`config/config.yml`：

```yaml
cdn:
  # 唯一域名：客户端取资源、游戏服取 token 都用它（裸主机名）
  host: "cdn.example.com"
  prefix: ""                         # 可选，作为 X-CDN-Prefix
  apiKey: "<与 cdnapi 相同>"
  timeoutMs: 3000
```

游戏服不需要 `tokenSecret`，也不需要重启才能换内容；它只在每次登录时向 cdnapi 要一份 token。

### 1.5 TLS / 反向代理

客户端**硬编码 https + 443**，并且只信任系统/内置 CA 签发的证书。

```nginx
server {
    listen 443 ssl http2;
    server_name cdn.example.com;

    ssl_certificate     /etc/letsencrypt/live/cdn.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cdn.example.com/privkey.pem;

    # 控制面：游戏服取 token。建议只允许游戏服来源。
    location = /token {
        allow 127.0.0.1;          # 游戏服与 cdnapi 同机
        allow <game-server-ip>;   # 游戏服在别的机器时填它的出口 IP
        deny all;

        proxy_pass http://127.0.0.1:25570;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # 数据面：客户端
    location / {
        proxy_pass http://127.0.0.1:25570;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

游戏服和 cdnapi 同机时，公网域名可能触发 NAT 回环失败：在游戏服所在机器的
hosts 里加一行 `127.0.0.1 cdn.example.com`，让取码请求走本地。

游戏服取码也走 `https://<cdn.host>/token`，Node 会校验证书；用私有 CA 时要让游戏服
信任该 CA（或直接用公网可信证书）。

### 1.6 启动与自检

```bash
cd cdnapi
cnpm install
npm start
```

启动日志应包含 `buildCL=423273`、`apiKey=set`。

三项自检：

```bash
# 1) 取码（控制面）
curl -s -X POST http://127.0.0.1:25570/token \
  -H "content-type: application/json" \
  -H "x-api-key: <cdn.apiKey>" \
  -d '{"user_id":"79a9c25c-be60-4da5-9f80-ea24c04cd268"}'

# 2) 清单（数据面，用上一步返回的 token）
curl -s -D- -o /tmp/manifest.bin http://127.0.0.1:25570/manifest \
  -H "Authentication: Bearer <token>"

# 3) 任意一个条目的资源块
curl -s -D- -o /tmp/blob.bin http://127.0.0.1:25570/resources/<40位sha1> \
  -H "Authentication: Bearer <token>"
```

```bash
node tools/build.js --inspect data/base/win/resource.manifest   # 查看基线清单信息
```

### 1.7 客户端首次验证（此时还没有任何自定义内容）

1. 重启游戏（重新登录）。
2. cdnapi 日志应出现：

   ```
   Issued resource token  sub=<你的 user_id>  exp=...
   request POST /manifest  status=200
   ```

3. 因为清单与 ROM 完全一致（只多了 buildCL），**不应出现任何 `/resources/...` 请求**。
4. 游戏正常进入 → 链路打通。

---

## 2. 下发一次更新

### 2.1 找到要覆盖的文件名

从基线清单里查（名字就是游戏内部加载的路径，**大小写敏感**）：

```bash
cd cdnapi
npm run inspect | head -40
# 或者直接解析
node -e "
const {parseManifest}=require('./src/manifest');
const fs=require('fs');
const m=parseManifest(fs.readFileSync('data/base/win/resource.manifest'));
for (const e of m.entries.filter(e=>/RainTreeNub/i.test(e.name)))
  console.log(e.category, e.name, e.hash.toString('hex'), e.compressedSize);
"
```

输出示例：

```
meshes Data/Meshes/Bin/RainTreeNub_01.mesh c64bec0365b14ce1e80481334061187aea46ca92 3685
```

### 2.2 放进 content

布局必须与 `data/assets` 一致：`content/<category>/<name>`（所有平台共享同一份内容）。

```bash
mkdir -p content/meshes/Data/Meshes/Bin
cp /path/to/new/RainTreeNub_01.mesh content/meshes/Data/Meshes/Bin/
```

- 同名 → 覆盖清单里的旧条目；
- 第一段必须是已知 category（`manifest.categories` 或基线清单里出现过的），否则会按
  `manifest.defaultCategory` 处理，名字变成整段路径（通常不是你要的）。

### 2.3 重启 cdnapi

服务只在启动时构建清单（`content/` 改动不会热更新）：

```bash
# Ctrl+C 后
npm start
```

启动日志会显示新的 `entries=…` / `overlay=1`，以及新的 `resourceHash`。
`npm run build` 不是必须的，只是把同一份清单导出到 `data/manifests/<platform>/` 方便检查。

### 2.4 确认新清单

```bash
curl -s http://127.0.0.1:25570/health
```

关注：

- `buildCL`：默认 `base.buildCL + 1`（0.35.1 = 423273），必须**大于**客户端 ROM 的 buildCL；
- `resourceHash`：内容一变就会变；
- `overlayEntries`：等于你放进去的文件数。

也可以用 `npm run build` 后 `npm run inspect` 查看条目。

### 2.5 客户端验证

1. 完全退出并重启游戏。
2. cdnapi 日志应出现新的下载请求：

   ```
   request POST /manifest status=200 ... sub=<user_id>
   request GET /resources/<新sha1> status=200 ...
   ```

3. 如果看到的还是旧 sha1 或没有请求，见第 4 节排查。
4. 客户端侧日志（`Sky.log`）关键字：

   ```
   ::DoSync - Manifest query action: ...
   Downloading: <name> with SHA1: <sha1>
   ```

5. 客户端把块写入自己的本地资源缓存（按 SHA-1 命名），清单缓存为 `Data/resource.manifest`；
  具体根目录由客户端的可写数据目录决定。下次启动直接命中，不再下载。

### 2.6 回滚

```bash
rm content/meshes/Data/Meshes/Bin/RainTreeNub_01.mesh
# 重启 cdnapi
```

- 新清单一发布，该名字重新指回 ROM 的 SHA-1；
- 客户端本地仍保留 ROM 块，通常**不需要重新下载**；
- `buildCL` 不变也没关系：客户端缓存清单仍然大于 ROM 清单，会继续用缓存清单，
  只是内容回到基线。

---

## 3. 批量更新 / 日常发布

推荐流程：

```
1. 改 content/ 下的文件
2. npm start（重启 cdnapi）
3. curl /health 记录 buildCL + resourceHash
4. 重启客户端验证
5. 有问题 → 撤掉对应文件 → 再重启
```

发布检查清单：

- [ ] 文件名与基线清单完全一致（大小写、路径分隔符 `/`）
- [ ] 文件格式与目标资源兼容（如 `.spv` 必须是同版本着色器）
- [ ] cdnapi `/health` 的 `buildCL > 客户端 ROM buildCL`
- [ ] 日志里能看到客户端下载了新的 sha1
- [ ] 回滚用的原文件已备份

> 游戏大版本更新后：重新复制对应平台的 ROM 清单到 `data/base/<platform>/resource.manifest`，
> 重启 cdnapi。新的 `base.buildCL` 会让该平台的默认 buildCL 自动抬高。

---

## 4. 排错对照表

| 现象 | 可能原因 | 处理 |
|---|---|---|
| cdnapi 日志完全没有请求 | 游戏服 `cdn.host` 为空 / 客户端没重启 / 取码失败 | 看游戏服日志 `[CDN] resource token request failed`；先测 `POST /token` |
| 游戏服日志 `HTTP 401` | 两边 `apiKey` 不一致 | 对齐 `cdn.apiKey` |
| `/token` 返回 500 | cdnapi `cdn.tokenSecret` 为空 | 填一个随机 32+ 字符串 |
| 客户端 `Version mismatch` | `manifest.base` 是旧版（v1，如 0.15.1） | 换 0.35.1 的 v3 清单 |
| 客户端 `Header magic mismatch` / `length mismatch` / `crc mismatch` | 清单被手工改过或生成器不对 | 用本服务重新生成，不要手改二进制 |
| `POST /manifest` 404/403 | 反代路径、token 过期、`env` 不匹配、`requirePrefix` 严格 | 看 cdnapi 日志状态码；核对 `cdn.env` / `cdn.prefix` |
| 机器人和电脑拿到同一份清单 | 游戏服没传 `platform` / cdnapi 没有该平台 base | 看 cdnapi 日志 `Unknown platform`；检查 `data/base/<platform>/resource.manifest` |
| `GET /resources/<sha1> 404` | `content/` 里没有该块，且没配 `assets.dir` | 放文件或配置 `assets.dir` 指向游戏 `data/assets` |
| 下载发生但游戏里没变化 | 文件名不对 / 该文件不被加载 / buildCL 不够高 | 核对 name 大小写；确认 `buildCL` 大于 ROM；确认游戏确实加载该资源 |
| 每次启动都重复下载 | 缓存清单没被采用（buildCL 不高于 ROM） | 抬高 `manifest.buildCL` |
| 长时间会话后下载 401 | token 过期 | 提高 `tokenTtlSeconds`（默认 86400） |
| 客户端完全连不上 | 非 443 / 证书不可信 / **游戏服** `cdn.host` 带了 `https://` 或端口 | 用可信证书 + 裸域名 |
| 游戏服启动后客户端不同步 | 游戏服 `cdn.host` 为空 / 取码失败 | 看 `/token` 是否 200，检查 `cdn.host` |

---

## 5. 运维建议

- **密钥**：`cdn.apiKey` 和 `cdn.tokenSecret` 都用独立随机值；apikey 只给游戏服，
  tokenSecret 不外发。轮换 apikey 时同时改两侧并重启。
- **备份**：`config/config.yml`、`content/`、`data/base/<platform>/resource.manifest`。
- **日志**：cdnapi 每次请求都记录 `status / sub / prefix / platform`；出现 404 会额外 warn 一次
  （同一 sha1 只报一次）。
- **缓存**：`/resources/<sha1>` 是内容寻址，可在 nginx 上做长缓存：

  ```nginx
  location /resources/ {
      proxy_pass http://127.0.0.1:25570;
      add_header Cache-Control "public, max-age=31536000, immutable";
  }
  ```

  客户端本身不发送条件请求，缓存主要服务中间层/多客户端。
- **容量**：清单里只记录索引，实际体积都在 `content/`；首次全量下发时注意出口带宽。
- **安全**：`/token` 只允许内网访问更稳妥（在 nginx 上按来源 IP 限制），不要把它暴露给公网。
