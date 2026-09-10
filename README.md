<div align="center">

# Wallpaper Engine PKG 提取器 Web

[English](README_EN.md) | 简体中文

</div>

在**用户浏览器本地**解析 Wallpaper Engine 的 `.pkg`（桌面）/ `.mpkg`（安卓）壁纸包，提取 jpg / png / mp4 / webm 及包内任意资源；支持 `.tex` 解码转换与动画贴图重编码为 APNG / GIF；一切行为均在本地进行，与网站服务器无关，可静态部署。[示例网站](https://pkg.cdsp.us.ci)

## 功能

- 拖拽 / 选择 `.pkg` / `.mpkg` 文件，最大接近 2GB（解析只读目录表，包体不驻留内存）
- 条目列表 + 图片/视频缩略预览 + 大图弹窗
- `.tex → jpg/png/mp4` 自动转换（可关闭，关闭则原样导出 `.tex`）
- 动画贴图（带帧表的 `.tex`）重编码为单个 **APNG**（无损、保留透明）或 **GIF**（256 色、体积小），也可两者都出
- 多选卡片：选中文件一键下载 / 打包为 ZIP
- 单文件下载 / 保留目录结构的 ZIP 批量打包（流式写出，不把整包读进内存）
- 筛选（图片/视频/JSON）、`project.json` 元数据卡片

## 开发与验证

```bash
cd we-pkg-web
npm install
npm run dev        # http://localhost:5199
```

## Pages部署

- 克隆此项目

  ```
  git git clone https://github.com/CelestialDomeStarPole/WallpaperEngine-PKG-Extractor-Web.git
  ```

  在项目根目录下执行

  ```bash
  npm run build
  ```

  产物在 `dist/`，将 `dist/` 上传到 GitHub Pages / Cloudflare Pages / 任意静态托管即可，无后端、无网络请求。

- 或者fork此项目
  Cloudflare 链接你的账户并选择fork后的仓库进行**Pages**部署

### CF Pages 构建配置设置

| 类别 | 内容 |  
| :--- | :--- |  
| 框架预设 | 无 |  
| 构建命令 | `npm run build` |  
| 输出目录 | `dist` |  
| 根目录 | 留空 |  

## Workers部署

- 克隆此项目并将文件夹上传至 Cloudflare Workers 部署
- 或者fork此项目 Cloudflare 链接你的账户并选择fork后的仓库进行**workers**部署

### CF Wokers 构建配置设置

| 类别 | 内容 |  
| :--- | :--- |  
| 构建命令 | `npm run build` |  
| 部署命令 | `npx wrangler deploy` |  
| 版本命令 | `npx wrangler versions upload` |  
| 根目录 | `/` |  

## 未来

- 加密支持pkg支持

## 格式参考

- 容器与 TEX 布局逐字节翻写自 [notscuffed/repkg](https://github.com/notscuffed/repkg)(MIT)
- 实测动画贴图（`flags & 4`）：所有帧共用**一张雪碧图**，帧表的 `x/y/width/height` 是该图内的**源格子**（像素单位），`TEXS0003` 的 `gifWidth/gifHeight` 才是输出画布尺寸，`frametime` 单位为秒
- 第二期加密支持：在 `src/core/adapter.ts` 注册新 `ContainerAdapter`（`PKG ` v1/v2：AES-CTR keystream + 逐文件 zlib），核心流程无需改动。

## 已知限制

- Workshop 加密包（`PKG ` v1/v2）暂不支持，第二期提供
- 不支持 `.webm/.mp4` 之外的音视频特殊格式
- PKGV（桌面 `.pkg`）/ PKGM（安卓 `.mpkg`）目录表的偏移字段是 int32，因此 **>2GB 的包在格式层面就无法存在**，这类文件会被直接拒绝
- 单个动画重编码输出超过 200MB 时自动回退为第 0 帧 PNG，并弹窗说明原因
