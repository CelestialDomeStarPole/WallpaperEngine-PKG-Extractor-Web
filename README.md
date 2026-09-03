<div align="center">

# Wallpaper Engine PKG 提取器 Web

[English](README_EN.md) | 简体中文

</div>

在**用户浏览器本地**解析 Wallpaper Engine 的 `.pkg` 壁纸包，提取 jpg / png / mp4 / webm 及包内任意资源；支持 `.tex` 解码转换；一切行为均在本地进行，与网站服务器无关，可静态部署。[示例网站](https://pkg.cdsp.us.ci)

## 功能

- 拖拽 / 选择 `.pkg` 文件（≤200MB）
- 条目列表 + 图片/视频缩略预览 + 大图弹窗
- `.tex → jpg/png/mp4` 自动转换（可关闭，关闭则原样导出 `.tex`）
- 单文件下载 / 保留目录结构的 ZIP 批量打包
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

## Workers部署

- 克隆此项目并将文件夹上传至 Cloudflare Workers 保持默认选项部署
- 或者fork此项目 Cloudflare 链接你的账户并选择fork后的仓库进行**workers**部署

## 未来

- 加密支持pkg支持
- APNG/GIF 重编码

## 格式参考

- 容器与 TEX 布局逐字节翻写自 [notscuffed/repkg](https://github.com/notscuffed/repkg)(MIT)
- 第二期加密支持：在 `src/core/adapter.ts` 注册新 `ContainerAdapter`（`PKG ` v1/v2：AES-CTR keystream + 逐文件 zlib），核心流程无需改动。

## 已知限制

- 动画 GIF tex 第一期导出首帧 + 全部帧 PNG，不做 APNG/GIF 重编码
- 不处理音频壁纸 mp3 之外的特殊格式；>200MB 文件拒绝
