# Obsidian Asset Resolver

在 Obsidian 里，有些笔记会引用相对路径图片，例如：

```md
![diagram](../assets/images/diagram.png)
```

如果这个文件还在 vault 里，Obsidian 会正常显示它。  
如果你为了给 vault 瘦身，把大批附件搬到了自己的对象存储、NAS 或静态文件服务里，这类图片就会变成 “could not be found”。

Asset Resolver 会在本地文件缺失时，自动从你配置的远端镜像加载图片。它不会改写你的 Markdown，也不会自动上传文件。

## 适合谁

- 你想把大批图片附件移出 Obsidian vault。
- 你仍然希望旧笔记里的相对路径图片能正常预览。
- 你有自己的远端存储，例如 S3-compatible 服务、RustFS、MinIO、NAS 上的静态服务或 CDN。
- 你希望本地文件存在时优先使用本地文件，本地缺失时才访问远端。

## 工作方式

插件会检查笔记里的本地图片引用：

- 本地文件存在：交给 Obsidian 原样显示。
- 本地文件不存在：按你配置的镜像地址生成远端 URL。
- 如果配置了 asset manifest：只解析 manifest 里列出的文件，避免对未知路径盲目尝试。
- Obsidian 预览区滚动时才渲染的新内容，也会继续被处理。
- 短期签名 URL 过期导致图片加载失败时，会重新签名并重试一次。

## 安装

### 使用 BRAT

如果你使用 BRAT，可以添加这个仓库：

```text
https://github.com/etng/obsidian-asset-resolver
```

然后启用插件 `Asset Resolver`。

### 手动安装

下载以下文件：

- `manifest.json`
- `main.js`

放到你的 vault 插件目录：

```text
.obsidian/plugins/obsidian-asset-resolver/
```

然后在 Obsidian 的 Community plugins 中启用 `Asset Resolver`。

## 配置

打开 Obsidian 设置，进入 `Asset Resolver`。

默认情况下，插件使用自己的 Obsidian 配置文件：

```text
.obsidian/plugins/obsidian-asset-resolver/data.json
```

如果你确实希望把真实后端配置集中放在另一个 vault 内 JSON 文件，也可以让插件目录里的 `data.json` 只保留：

```json
{
  "settingsPath": "config/obsidian-asset-resolver.config.json"
}
```

### Local prefixes

这里填写你希望插件接管的本地附件前缀。默认值适合常见的相对路径图片：

```text
../assets/
./assets/
assets/
```

### Public URL mirror

如果你的图片可以通过普通 HTTPS 地址访问，可以配置 public URL 后端：

```json
[
  {
    "name": "Public asset mirror",
    "type": "public-url",
    "baseUrl": "https://assets.example.com/"
  }
]
```

当笔记里引用 `../assets/images/a.png` 时，插件会尝试：

```text
https://assets.example.com/images/a.png
```

### S3-compatible private mirror

如果你使用 S3-compatible 服务，可以让插件在本地临时生成签名 URL：

```json
[
  {
    "name": "Private asset mirror",
    "type": "local-sigv4",
    "endpoint": "https://s3.example.com",
    "bucket": "my-assets",
    "region": "us-east-1",
    "keyPrefix": "",
    "accessKeyId": "YOUR_ACCESS_KEY_ID",
    "secretAccessKey": "YOUR_SECRET_ACCESS_KEY",
    "expiresInSeconds": 300,
    "forcePathStyle": true
  }
]
```

建议使用只读、范围受限的访问凭据，不要使用管理员账号。

## Asset manifest

manifest 是可选的，但强烈建议使用。它能让插件只解析你已经登记过的对象，减少误访问和隐私风险。

推荐使用 JSON Lines，每行一个对象。这样后续批量上传新目录时可以直接追加，不需要重写整个 manifest：

```jsonl
{"remote_key":"images/a.png","asset_key":"images/a.png","markdown_path":"../assets/images/a.png"}
{"remote_key":"screenshots/b.png","asset_key":"screenshots/b.png","markdown_path":"../assets/screenshots/b.png"}
```

同一个 `asset_key` 出现多次时，后面的记录覆盖前面的记录。

也支持普通 JSON 格式：

```json
{
  "assets": [
    {
      "remote_key": "images/a.png",
      "asset_key": "images/a.png",
      "markdown_path": "../assets/images/a.png"
    }
  ]
}
```

更多字段可以参考：

- [examples/asset_manifest.example.json](examples/asset_manifest.example.json)
- [examples/asset_manifest.example.jsonl](examples/asset_manifest.example.jsonl)

## 安全建议

- 私有对象存储不要开放匿名访问。
- 使用短有效期签名 URL。
- 使用只读、范围受限的访问凭据。
- 不要把 Obsidian 插件设置文件提交到公开仓库。
- 不要把包含真实对象清单的 manifest 提交到公开仓库，除非这些对象本身就是公开资料。

## 常见问题

### 它会修改我的笔记吗？

不会。插件只改变预览时的显示方式，不改写 Markdown 文件。

### 本地文件还在时会访问远端吗？

不会。只要 Obsidian 能找到本地文件，插件就不会接管。

### 图片滚动到页面中才出现，插件还能处理吗？

可以。Obsidian 会延迟渲染长笔记的内容，插件会监听预览区的新节点并继续处理。

### 页面停留很久后图片 403 怎么办？

如果使用短期 S3 SigV4 URL，页面停留超过有效期后，浏览器重新加载图片可能拿到 403。插件会重新签名并重试一次。若重试后仍失败，通常说明对象不存在、manifest 映射错误或后端权限配置不正确。

### 它能上传图片吗？

不能。这个插件只负责预览时解析缺失图片。上传、同步和生成 manifest 需要你用自己的工具完成。

### 支持哪些远端？

目前支持：

- 普通 public URL 镜像
- S3-compatible SigV4 签名 URL

RustFS、MinIO 和很多兼容 S3 的对象存储通常可以使用 S3-compatible 配置。

## License

MIT
