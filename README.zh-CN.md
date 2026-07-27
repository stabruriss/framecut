<p align="center">
  <img src="./public/framecut-mark.svg" width="76" alt="Framecut 标志">
</p>

<h1 align="center">Framecut</h1>

<p align="center">
  在 Chrome 中把整卷负片扫描无损切成独立 TIFF。
</p>

<p align="center">
  <a href="https://github.com/stabruriss/framecut/releases/latest/download/Framecut.html"><strong>下载 Framecut.html</strong></a>
  ·
  <a href="https://github.com/stabruriss/framecut/releases">全部版本</a>
  ·
  <a href="./LICENSE">MIT License</a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

很多摄影店提供的负片扫描服务，会把多张底片扫描进同一个 TIFF 文件。

Framecut 可以直接在 TIFF 上指定每张底片的范围，以像素无损方式切成独立 TIFF，并批量存入指定文件夹，方便直接导入 Lightroom 去除色罩和继续编辑。

整个工具在 Chrome 中本地运行：无需额外安装 App，无需联网，也不会上传你的照片。

## 快速开始

1. [下载 `Framecut.html`](https://github.com/stabruriss/framecut/releases/latest/download/Framecut.html)。
2. 使用桌面版 Chrome 打开。如果系统默认使用其他浏览器，可以把文件拖进 Chrome，或选择**打开方式 → Google Chrome**。
3. 把 `.tif` 或 `.tiff` 拖进页面。
4. 在每张照片周围画框。多个框可以互相重叠。
5. 点击 **Choose Folder & Export**，选择一个可写入的子文件夹。Framecut 会自动建立带时间戳的批次目录，并把所有裁切 TIFF 写入其中。

地址栏显示 `file:///` 开头的地址属于正常现象。界面、字体、Worker、libtiff 和 WebAssembly 引擎都已内嵌到 HTML 中，不需要本地服务器，也不会发起网络请求。

> Chrome 会保护“下载”“文稿”等顶层目录。请在里面新建或选择一个普通子文件夹，例如 `下载/Framecut`，再把文件导出到这里。

## 功能

- 只有一个可携带的 HTML 文件，无需安装程序、后端或账户
- 使用桌面版 Chrome 在本机离线处理
- 以像素无损方式裁切 8-bit 和 16-bit TIFF
- 支持多个互相重叠的裁切框
- 可以移动、缩放、复制和删除裁切框
- 自动处理 TIFF `Orientation=1–8` 的预览和输出方向
- 顺序写入文件夹，内存使用更可控
- 无法直接写入目录时提供 ZIP 后备输出
- 保留 ICC 配置文件及常见摄影元数据

## 操作

| 操作 | 控制方式 |
| --- | --- |
| 画框 | 画框工具或 `D`，然后拖动 |
| 选择框 | 点击裁切框或按 `V` |
| 移动底图 | 手形工具或 `H`；任意工具下按住空格拖动 |
| 复制框 | 复制按钮，或先按 `Command/Ctrl + C`，再按 `Command/Ctrl + V` |
| 删除框 | `Delete` 或 `Backspace` |
| 缩放 | 鼠标滚轮或缩放控制面板 |
| 取消选择 | 点击选中框外的空白处 |

## 支持的 TIFF

| 属性 | 支持范围 |
| --- | --- |
| 页面 | TIFF 第 1 页 |
| Sample | 无符号 8-bit 或 16-bit |
| 色彩 | 灰度（`MinIsBlack` / `MinIsWhite`）或三通道 RGB |
| 布局 | Stripped、Planar Contiguous |
| 方向 | `1–8`，自动校正 |
| 输入压缩 | 无压缩、LZW、PackBits、Deflate / Adobe Deflate |
| 输出 | Classic TIFF、Adobe Deflate、horizontal predictor |
| 单个裁切框裸像素上限 | 384 MiB |
| 单个源 Strip 解码上限 | 512 MiB |

目前明确不支持：

- Tiled TIFF 或 Planar Separate TIFF
- Alpha、CMYK、Lab、浮点或有符号 Sample
- JPEG-in-TIFF 以及上表之外的压缩格式
- BigTIFF 输出
- Photoshop 图层、复杂 SubIFD 或任意专有扫描仪标签

## “像素无损”的准确含义

正式输出不经过浏览器 Canvas。Canvas 只生成最长边不超过 2400 像素的 8-bit 定位预览。libtiff 引擎会解码相关源 Strip，不经过缩放、插值或色彩转换，直接复制选中区域的每个 8-bit 或 16-bit Sample，再用 Adobe Deflate 和 horizontal predictor 重新编码。

因此，裁切图像的 Sample 与源图对应区域完全一致。输出文件并非源文件的字节级切片：压缩流、Strip 布局和部分 TIFF Tag 会改变。ICC、分辨率、白点、色度以及常见描述字段会在存在时保留。XMP/XMLPacket、Photoshop resource block、图层和未支持的私有 Tag 不会复制。

## 输出与内存

桌面版 Chrome 会通过 File System Access API 在每张照片编码完成后立刻写入磁盘。每批输出都会建立类似 `framecut-20260727-090503` 的文件夹，其中包含 `framecut-20260727-090503-01.tif` 等文件。

如果浏览器无法写入目录，Framecut 会在内存中建立 ZIP。ZIP 后备路径限制为 512 MiB 预计裸像素和 512 MiB 累计编码 TIFF。大文件或大量裁切框应使用目录直写。

单文件版会在专用 Worker 中运行 libtiff，TIFF 处理不会占用界面线程；引擎本身是单线程的，不会吃满所有 CPU 核心。源文件按 Strip 增量读取，不会先完整复制到一个 `ArrayBuffer` 中。

## 浏览器支持

正式支持目标是桌面版 Google Chrome。其他 Chromium 浏览器可能可以运行，但不在发布验收范围内。目前不支持 Safari 和 Firefox。

## 开发

环境要求：

- Node.js `20.19+` 或 `22.12+`
- npm

```bash
npm ci
npm test
npm run build:single
```

最终发行文件会生成在：

```text
dist-single/Framecut.html
```

仓库已包含生成好的单线程 libtiff 引擎，因此普通开发不需要安装 Emscripten。只有重新构建引擎本身时，才需要精确使用 Emscripten `4.0.23`：

```bash
./scripts/build-libtiff-engine.sh
npm run build:single
```

贡献方式参见 [CONTRIBUTING.md](./CONTRIBUTING.md)，依赖许可证参见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 许可证

Framecut 使用 [MIT License](./LICENSE) 发布。
