# Framecut

Framecut 用来把整版胶片、接触印相或拼版扫描 TIFF 裁成独立照片。默认发行物只有一个 `Framecut.html`：下载后用桌面版 Chrome 打开，拖入 TIFF、画框、输出即可。它不需要安装应用、启动服务器或连接后端，照片也不会上传。

当前目录是未来独立开源仓库的孵化版本。

## 直接使用

1. 下载 `Framecut.html`。
2. 双击打开；如果系统没有用 Chrome 打开它，可把文件拖进 Chrome，或右键选择“打开方式 → Google Chrome”。
3. 把 `.tif` / `.tiff` 拖进页面，或点击选择文件。
4. 在预览上画出需要的照片。可以建立多个裁切框，并且允许互相重叠。
5. 点击“选择文件夹并输出”，授权 Chrome 写入目标文件夹。

地址栏显示类似 `file:///…/Framecut.html` 是正常的。界面、字体、Worker、libtiff 和 WebAssembly 引擎都已经内嵌，页面运行时不会下载其他资源。当前以桌面版 Chrome 为正式支持目标；Edge 等其他 Chromium 浏览器可能也能运行，但尚未作为发布基线验证。

## 操作

- 画框工具：拖动建立新裁切框，快捷键 `D`
- 选择工具：选择、移动或从四角缩放裁切框，快捷键 `V`
- 手形工具：平移画布，快捷键 `H`
- 鼠标滚轮：缩放画布
- `Delete` / `Backspace`：删除当前裁切框
- 点击右侧清单中的编号或名称：选择对应裁切框

输出文件按源文件名依次编号，例如 `roll-01_01.tif`、`roll-01_02.tif`。输出前如果目标文件夹已有同名文件，Framecut 会先询问是否覆盖。

## 输出方式

桌面版 Chrome 会通过 File System Access API 直接写入所选文件夹。各裁切框按顺序编码、写盘，不会等全部成品都完成后再落盘；这是大量照片时的推荐方式。

如果浏览器没有目录写入能力，或目录写入初始化失败，Framecut 会改为生成一个 ZIP。处理完成后需要点击页面显示的下载链接。ZIP 内仍然是独立的无损 TIFF，ZIP 本身使用 store 模式，因为 TIFF 已经经过 Deflate 压缩。

ZIP 后备路径会在内存中保留所有成品。开始编码前，Framecut 会按裁切框尺寸预估裸像素合计，超过 512 MiB 就拒绝进入 ZIP 模式；编码过程中，如果累计写入归档的 TIFF 成品超过 512 MiB，也会停止。大文件或很多裁切框应优先使用 Chrome 的目录直写。主动取消文件夹选择只会取消本次输出，不会自动改为 ZIP。

## “无损”的准确含义

正式输出不经过浏览器 Canvas。Canvas 只显示最高 2400 像素的 8-bit 定位预览并记录坐标；libtiff 会按 strip 解码源 TIFF，从对应行原样复制每个 8-bit 或 16-bit sample，再用 Adobe Deflate + horizontal predictor 重新编码。

因此：

- 输出区域的像素 sample 与源图对应区域一致，没有缩放、插值或色彩转换。
- 输出不是源文件的字节级切片；压缩流、strip 布局和部分 TIFF Tag 会变化。
- ICC、分辨率、白点/色度以及常见描述字段会在存在时复制。
- XMP / XMLPacket 和 Photoshop resource block 会有意丢弃；未显式支持的私有 TIFF Tag、复杂 SubIFD 和图层结构也可能丢失。
- 预览只用于确定裁切位置，不应拿来判断 16-bit 层次或严格色彩。

## 当前支持范围

| 项目 | 单文件版支持 |
| --- | --- |
| 页面 | 单页；多页文件只打开第 1 页 |
| sample | unsigned integer 8-bit 或 16-bit |
| 通道 | 单通道灰度（MinIsBlack / MinIsWhite）或三通道 RGB |
| 布局 | stripped、Planar Contiguous、`Orientation=1` |
| 输入压缩 | 无压缩、LZW、PackBits、Deflate / Adobe Deflate |
| 输出 | Classic TIFF、Adobe Deflate、horizontal predictor |
| 单个裁切框 | 裸像素最多 384 MiB |
| 源 strip | 单个 strip 解码后最多 512 MiB |

当前明确不支持：

- tiled TIFF、Planar Separate TIFF
- alpha、CMYK、Lab、浮点或有符号 sample
- JPEG-in-TIFF 及上表之外的压缩方式
- 自动旋转 `Orientation` 不为 1 的图像
- BigTIFF 输出
- XMP / XMLPacket、Photoshop resource block、Photoshop 图层、复杂 SubIFD 或任意专有扫描仪标签的保留

## 性能与内存

单文件版使用单线程 libtiff WebAssembly 引擎。解码和编码都在 Worker 中进行，所以编辑界面与 TIFF 处理隔离；代价是它不会像多线程原生应用那样吃满多个 CPU 核心。

源文件由 Worker 通过浏览器 `File` 分段读取，不会先把整个 TIFF 复制成一个 `ArrayBuffer`。引擎按 strip 解码并缓存当前 strip，单个 strip 解码后的硬上限为 512 MiB。WASM 内存从 64 MiB 开始，按需增长，配置上限为 2 GiB；浏览器或机器可能更早遇到实际内存限制。每个裁切框还会产生压缩后的输出缓冲，因此处理大图时应先用一个较小的框试跑。

目录直写会顺序处理并及时写出每张 TIFF，内存更可控。ZIP 后备路径必须把所有成品保留到归档完成，峰值内存会明显更高。

## 构建单文件版

普通前端构建只需要 Node.js 20.19+ 或 22.12+；仓库已经包含生成好的单线程 libtiff 引擎。

```bash
cd TOOLS/framecut-pwa
npm install
npm run build:single
```

唯一的运行产物是：

```text
dist-single/Framecut.html
```

可以直接双击该文件做 `file://` 验收，不需要 `npm run preview`。`dist-single/` 是生成目录，不提交到 Git；发布时可把 `Framecut.html` 作为 Release 附件。

若修改了 C wrapper 或需要从上游重新生成 WebAssembly 引擎，需要精确使用 Emscripten 4.0.23，并让 `emcc`、`emconfigure` 和 `emmake` 位于 `PATH`，再运行：

```bash
./scripts/build-libtiff-engine.sh
npm run build:single
```

脚本会拒绝其他 Emscripten 版本，并固定下载、校验 libtiff 4.7.2。生成的 `engine/dist/libtiff-engine.mjs` 会提交到仓库，因此最终用户和普通前端开发者都不需要安装 Emscripten。

## 验证

```bash
npm test
npm run build:single
```

仓库带有一张确定性的 16-bit RGB + ICC 验收图。按 `tests/fixtures/README.md` 中的坐标从浏览器导出后，可验证尺寸、每个 sample 和 ICC 原始字节：

```bash
node scripts/tiff-acceptance.mjs verify \
  tests/fixtures/rgb16-icc-source.tif \
  /path/to/exported.tif \
  3 2 9 6
```

## 可选：服务器 / PWA 模式

原来的多文件 PWA 仍然保留，适合作为 wasm-vips 兼容路径或继续开发时使用，但它不是默认分发方式。该模式依赖 SharedArrayBuffer，必须从 localhost 或 HTTPS 提供，并返回：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite 开发和预览服务器已经配置这些响应头：

```bash
npm run dev

# 或构建可安装、可离线缓存的 PWA
npm run build
npm run preview
```

生产 PWA 会缓存界面、字体、Worker 和 wasm-vips 运行文件。开发模式刻意不注册 Service Worker，以免旧缓存干扰调试。`npm run dev` 和 `npm run build` 会自动把 wasm-vips 运行文件及其许可证复制到 `public/vendor/wasm-vips/`，这些生成文件不提交到 Git。

锁定的 `wasm-vips 0.0.18` 会建立固定 1 GiB 的共享 WASM heap，由内部线程共用，并非每个线程各占 1 GiB。此前开发机基线为：6000 × 4000、16-bit RGB、137 MB 输入，顺序输出 12 张 1800 × 850 TIFF，完整任务约 4.26 秒，像素差为 0；这只是旧 PWA 引擎的一次实测，不代表单文件版性能，也不是性能承诺。

## 目录结构

```text
single.html                         单文件版 HTML 入口
vite.single.config.ts              内联脚本、字体、Worker 和引擎的构建配置
src/single-main.tsx                单文件版应用入口
src/components/EditorStage.tsx     画布、缩放、画框和重叠交互
src/lib/geometry.ts                像素坐标与边界规则
src/lib/single-tiff-worker-client.ts
                                    单文件版 Worker RPC
src/lib/zip-output.ts              ZIP 后备输出
src/workers/single-tiff.worker.ts  libtiff 文件读取、预览和裁切
engine/libtiff-wrapper.c           保持原始 sample 的窄 C wrapper
engine/dist/libtiff-engine.mjs     已生成并内联的 Emscripten 模块
scripts/build-libtiff-engine.sh    可复现的 libtiff 引擎构建
scripts/tiff-acceptance.mjs        像素与 ICC 验收工具
```

第三方组件及许可证见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。该文件是发布时应一并提供的法律说明，不是 `Framecut.html` 的运行依赖。
