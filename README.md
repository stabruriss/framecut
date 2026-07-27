# Framecut PWA

Framecut 是一个完全在浏览器本地运行的 TIFF 裁切工具。它面向整版胶片、接触印相或拼版扫描：拖入 TIFF，画出任意多个可重叠裁切框，然后把每一格写成独立的无损 TIFF。

当前目录是未来独立开源仓库的孵化版本，暂不发布、不上传任何照片。
它是纯 Web PWA，不套原生应用壳，因此不涉及 macOS 应用签名或 notarization。

## 已实现

- 拖入或选择 `.tif` / `.tiff`
- 在后台生成低分辨率 PNG 预览
- 绘制任意多个裁切框，允许重叠
- 选择、移动和四角缩放
- 滚轮缩放与画布平移
- 严格的像素坐标边界校验
- 选择输出目录并逐张写入 TIFF
- 输出使用 Deflate/ZIP + horizontal predictor
- 保持 8/16-bit 原始位深、通道、ICC、XMP 和常见 TIFF 元数据
- PWA manifest、离线缓存及安装图标
- 所有处理均在本机完成

## 本地运行

需要 Node.js 20.19+ 或 22.12+，以及桌面版 Chrome / Edge。

```bash
cd TOOLS/framecut-pwa
npm install
npm run dev
```

打开终端显示的 localhost 地址。开发模式会在首次载入 TIFF 时下载并初始化约 5 MB 的 WASM 引擎；生产 PWA 会在安装离线缓存时先下载引擎，首次载入 TIFF 时再初始化。

生产构建：

```bash
npm run build
npm run preview
```

要测试安装和离线模式，请使用上面的生产预览，而不是 `npm run dev`。生产页面首次打开后会缓存界面、字体、Worker 和 WASM 引擎；随后可从 Chrome / Edge 地址栏安装。开发模式刻意不注册 Service Worker，以免旧缓存干扰调试。

`npm run dev` 和 `npm run build` 会自动把 `wasm-vips` 所需的两个运行文件复制到 `public/vendor/wasm-vips/`。这些生成文件不提交到 Git。

每次生产构建还会根据全部构建产物生成独立的 Service Worker 缓存版本；新版本安装失败时不会污染仍在使用的旧离线版本。

## 为什么必须通过 localhost 或 HTTPS

`wasm-vips` 使用 SharedArrayBuffer，需要服务器返回：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite 的开发及预览服务器已经配置好。`public/_headers` 可直接用于 Cloudflare Pages 或 Netlify。GitHub Pages 不能自定义这些响应头，不适合直接托管当前多线程版本。

## “无损”的准确含义

正式输出不经过浏览器 Canvas。Canvas 只显示预览和记录坐标；裁切由 libvips 直接读取原始 TIFF sample，再用无损 ZIP 重新编码。

因此：

- 裁切区域的像素 sample 与原图对应区域一致。
- 输出文件不是原文件的字节级片段，压缩数据、strip 布局及部分标签会变化。
- ICC、XMP、分辨率和常见描述字段会保留。
- libvips 不认识的任意私有 TIFF Tag 可能丢失。
- 如果源文件早已使用 JPEG-in-TIFF，Framecut 无法恢复此前丢掉的信息，但不会再进行一次 JPEG 有损压缩。

## 当前支持范围

- 单页 TIFF；多页 TIFF 暂时只打开第一页
- 8-bit / 16-bit
- 已验证 RGB；灰度走相同无损路径
- `Orientation=1`
- Deflate、LZW、无压缩等 libtiff 可读取的常见输入
- 目录输出目前依赖 Chromium File System Access API
- 单个裁切框的裸像素上限为 384 MiB

暂不承诺：

- BigTIFF 输出
- CMYK / Lab 的准确预览
- 浮点 TIFF
- Photoshop 图层、复杂 SubIFD 或专有扫描仪标签
- Safari / Firefox 的直接目录写入

## 性能模型

输入文件通过 `FileReaderSync + SourceCustom` 分段随机读取，不会先用 `file.arrayBuffer()` 把整个 TIFF 再复制一份。多个输出按顺序生成并立即写盘，内存中不会同时保存 N 张成品。

目前锁定的 `wasm-vips 0.0.18` 会建立一个固定 1 GiB 的共享 WASM heap；它由内部线程共用，不是每个线程各占 1 GiB。关闭页面即可完全释放。

已验证基线：

```text
输入：6000 × 4000、16-bit RGB、137 MB TIFF
裁切：12 张 1800 × 850
输出：110 MB ZIP TIFF
WASM 初始化：约 0.23 秒
12 张编码：约 3.38 秒
完整任务：约 4.26 秒
像素差：0
```

这是开发机上的一次实测，不是性能承诺。

## 验证

```bash
npm test
npm run build
```

另有一个 Node 端引擎烟雾测试，可用于比较给定区域：

```bash
npm run smoke:engine -- input.tif output.tif 100 200 1200 800
```

之后可使用 ImageMagick、`tiffinfo` 或 `tiffcmp` 比较输出与原图相同区域的像素和标签。

## 目录结构

```text
src/components/EditorStage.tsx  画布、缩放、画框和重叠交互
src/lib/geometry.ts             像素坐标与边界规则
src/lib/tiff-worker-client.ts   主线程 RPC 和顺序输出
src/workers/tiff.worker.ts      File 流式读取、预览及无损 TIFF 编码
scripts/prepare-vips.mjs        准备 WASM 运行资源
scripts/engine-smoke.mjs        引擎级烟雾测试
```
