# XYSKY Resource CDN API（cdnapi）

> 首次接入、如何下发一次资源更新、回滚与排错：见 [docs/update-guide.md](docs/update-guide.md)。

为天光（Sky: Children of the Light，0.35.1）私服提供资源下发，并给游戏服签发玩家资源 token。

```
                      POST /token (X-API-Key)
   game server  ───────────────────────────────▶  cdnapi
        │                                          │  ── 签发 token
        │  ◀────────── { token, expires_at } ──────┘
        ▼  { host, prefix, token }        ← host/prefix 来自游戏服配置
   game client ── POST https://<host>/manifest ───▶│
                ── POST https://<host>/resources/…▶│   (Bearer token)
```

协议、二进制格式和判定逻辑均从 0.35.1 `libBootloader.so` 反推，并用本机安装的
`data/assets/initial/Data/Manifests/win/resource.manifest` 校验通过。

---

## 1. 两套凭据

| 凭据 | 位置 | 用途 |
|---|---|---|
| `cdn.apiKey` | 游戏服 `cdn.apiKey` **与** cdnapi `cdn.apiKey` | 游戏服调用 `POST /token` 的服务间鉴权（`X-API-Key`） |
| `cdn.tokenSecret` | 只在 cdnapi | cdnapi 自己签发/校验玩家资源 token（HS256），**不下发、不共享** |

---

## 2. 快速开始

```bash
cd cdnapi
cnpm install

# 1) base manifest（客户端自带的 ROM 清单）
#    Windows Steam 默认：
#    <Steam>/steamapps/common/Sky Children of the Light/data/assets/initial/Data/Manifests/win/resource.manifest
#    建议复制一份再引用：客户端同步成功后会覆盖游戏目录里的那份。
mkdir -p data/base
cp "<Steam>/steamapps/common/Sky Children of the Light/data/assets/initial/Data/Manifests/win/resource.manifest" data/base/resource.manifest

# 2) 编辑 config/config.yml
#    cdn.tokenSecret / cdn.apiKey 必填（公网 host 在游戏服配）

# 3) （可选）放自定义资源到 content/<category>/<name>
#    例：content/initial/Data/Shaders/Bin/Foo.fs.spv

# 4) 构建并检查
npm run build
npm run inspect

# 5) 启动
npm start
```

游戏服 `config/config.yml`：

```yaml
cdn:
  host: "cdn.example.com"
  prefix: ""
  apiKey: "<与 cdnapi 的 cdn.apiKey 相同>"
  timeoutMs: 3000
```

---

## 3. 客户端行为（已确认）

- 每次会话登录后，客户端请求 `/service/auth/api/v1/token` 一次。`host` 或 `token` 为空时
  `ResourceSyncBarn::StartSyncCdn` 直接返回，**不会发出任何 CDN 请求**。
- 数据面请求头固定为：

  ```
  Accept: */*
  Authentication: Bearer <token>      # 注意不是 Authorization
  X-CDN-Prefix: <prefix>              # prefix 非空时才发
  content-type: application/json      # 仅 /manifest
  ```

- 响应语义：

  | 状态 | 含义 |
  |---|---|
  | `200` | 成功（manifest 解析 / 资源落盘） |
  | `304` | 未修改（用缓存 / 跳过） |
  | `404` | 不存在（manifest 会清理缓存清单并回退 ROM 清单） |
  | 其它 | 失败，自动重试：1s、5s，共 3 次 |

- 资源 URL **没有**两级子目录：`resources/<sha1>`。`resources/<前两位>/<sha1>` 是客户端
  本地缓存路径，不要混淆。
- 客户端不校验 token 内容，只原样转发。

---

## 4. Manifest v3 格式

```
偏移  长度  字段
0     16    magic = "\0TGCManifest\r\n\0\0"
16    4     version        = 3
20    4     length         文件总字节数（必须严格相等）
24    4     crc32          整个文件的 CRC-32（计算时本字段置 0）
28    4     entryCount
32    4     entryFields    = 7
36    4     buildCL        changelist
40    4     resourceHash   内容版本号（R%08x）
44    N*28  条目表
44+28N …    负载区（category / name 字符串、20 字节 SHA-1）
```

每个条目 7 个 u32（磁盘顺序）：

| # | 字段 | 说明 |
|---|---|---|
| 0 | timestamp | Unix 秒 |
| 1 | compressedSize | 下载长度；客户端按它校验落盘字节数 |
| 2 | categoryOffset | **绝对文件偏移**，指向 `\0` 结尾字符串 |
| 3 | nameOffset | **绝对文件偏移**，逻辑名（`Data/...`） |
| 4 | pathHashOffset | **绝对文件偏移**，20 字节 SHA-1（文件内容） |
| 5 | size | 原始大小（官方清单里为 0） |
| 6 | type | **同步标记**：`0` = 已在 ROM（客户端忽略），`2` = 需要下发（客户端只为 `type=2` 创建下载动作） |

> 覆盖层条目必须写 `type = 2`，否则客户端会判定“清单无差异”而不下载。
> cdnapi 的 `store.js` 在建清单时会自动把 `content/` 里的条目设为 2。

实现见 `src/manifest.js`。条目按 `name` 唯一（客户端用 FNV-1a(name) 建索引）。

### buildCL / resourceHash 的作用

`CheckAndLoadManifest` 会比较 ROM 清单与缓存清单：

```
cache.buildCL > rom.buildCL   → 使用缓存清单（上次从 CDN 下载的那份）
否则                          → 使用 ROM 清单
```

所以自定义清单要在**下次启动**生效，`buildCL` 必须大于客户端 ROM 的 `buildCL`
（0.35.1 = `423272`）。本服务默认 `base.buildCL + 1`。

`resourceHash` 用来判断清单是否变化：相同则 `resource_sync_manifests_not_different`，
直接跳过同步。默认由条目表 CRC32 派生。

---

## 5. 内容组织

```
content/
  initial/Data/Shaders/Bin/Foo.fs.spv     → category=initial, name=Data/Shaders/Bin/Foo.fs.spv
  meshes/Data/Meshes/Bin/Bar_01.mesh      → category=meshes,  name=Data/Meshes/Bin/Bar_01.mesh
  Custom/Thing.bin                        → category=initial, name=Custom/Thing.bin
```

- 第一段是已知 category（配置 `manifest.categories` + base 清单里出现过的）时作为分类；
  否则整个相对路径作为 name，归入 `manifest.defaultCategory`。
- 每个文件：`pathHash = SHA1(内容)`，`compressedSize = size = 字节数`。
- 与 base 清单按 `name` 合并：同名覆盖，新名字追加。

`manifest.base` 强烈建议配置：只发覆盖条目时，客户端会把 ROM 里有、清单里没有的文件
视为“不在清单中”。

`assets.dir` 可选：指向游戏的 `data/assets`。这样 base 条目也能从本 CDN 回源
（`<assets>/<category>/<name>`），缓存被清空的客户端可以完整重下。

---

## 6. 接口

### POST /token（控制面，游戏服调用）

```http
POST /token
X-API-Key: <cdn.apiKey>
Content-Type: application/json

{ "user_id": "79a9c25c-be60-4da5-9f80-ea24c04cd268" }
```

```json
{ "token": "eyJ…", "expires_at": 1792953803 }
```

- `cdn.apiKey` 为空时接口开放（仅调试）；
- `cdn.tokenSecret` 为空则无法签发，返回 500；
- token claims：`{ env, purpose: ["resources"], sub, iat, exp }`；
- 游戏服拿到后，用自己的 `cdn.host` / `cdn.prefix` 组合成
  `{ host, prefix, token, status: "OK" }` 再返回给客户端。

### POST /manifest、GET /resources/:hash（数据面，客户端调用）

> 0.35.1 客户端实测：清单用 **POST**，资源块用 **GET**；服务端两个端点都同时接受 GET/POST，
> 方便用 curl/浏览器调试。

校验 `Authentication: Bearer <token>`（`purpose` 必须含 `resources`，`env` 匹配）。
`cdn.requirePrefix: true` 时还要求 `X-CDN-Prefix == cdn.prefix`。

### GET /health

返回 manifest 摘要与条目统计（不含密钥）。

---

## 7. 部署（nginx）

```nginx
server {
    listen 443 ssl http2;
    server_name cdn.example.com;

    ssl_certificate     /etc/letsencrypt/live/cdn.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cdn.example.com/privkey.pem;

    client_max_body_size 8m;
    proxy_read_timeout 120s;

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

客户端硬编码 `https`，只信任系统/内置 CA 签发的证书；自签证书不可用。

游戏服和 cdnapi 同机时，公网域名可能触发 NAT 回环失败：在游戏服所在机器的
hosts 里加一行 `127.0.0.1 cdn.example.com`，让取码请求走本地。

游戏服取码也走 `https://<cdn.host>/token`，Node 会校验证书；用私有 CA 时要让游戏服
信任该 CA（或直接用公网可信证书）。

---

## 8. 验证步骤

1. **格式**：`npm run inspect` 输出 `Manifest OK`。
2. **签发**：

   ```bash
   curl -s -X POST http://127.0.0.1:25570/token \
     -H "content-type: application/json" \
     -H "x-api-key: <cdn.apiKey>" \
     -d '{"user_id":"79a9c25c-be60-4da5-9f80-ea24c04cd268"}'
   ```

3. **数据面**：拿返回的 token 请求 `/manifest`，再用清单里的 sha1 请求 `/resources/<sha1>`。
4. **端到端**：游戏服 `cdn.host` 指向 cdnapi 域名，启动客户端，cdnapi 日志应出现
   `Issued resource token`、`POST /manifest`、`GET /resources/<sha1>`。
5. 客户端日志关键字：

   ```
   Header magic mismatch / Version mismatch / length mismatch / crc mismatch   → 格式问题
   ::DoSync - Manifest query action: ...                                      → 清单处理结果
   Downloading: <name> with SHA1: <hash>                                      → 正在下载
   resource_sync_failed_to_fetch_new_manifest                                 → 清单请求失败
   ```

---

## 9. 目录

```
cdnapi/
  config/config.yml      配置
  docs/update-guide.md   首次接入 / 更新发布 / 回滚 / 排错教程
  src/manifest.js        v3 解析/生成/CRC
  src/store.js           base+overlay 合并、blob 解析
  src/token.js           token 签发 / apiKey / Bearer 校验
  src/http/routes.js     POST /token、/manifest、/resources/:hash、/health
  src/app.js             启动
  content/               自定义资源
```

## 10. 已知边界

- 只实现单份清单；多版本分流需要按 `X-CDN-Prefix` 扩展。
- `manifest.base` 必须是 0.35.1（v3）清单；0.15.1 的 v1 清单会在版本校验处被拒。
- 资源按原始字节下发；二进制里没有 lz4/zstd/oodle 的容器级解压逻辑。
