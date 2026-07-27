#include <emscripten/emscripten.h>
#include <tiffio.h>

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FC_MAX_RAW_CROP_BYTES (384ULL * 1024ULL * 1024ULL)
#define FC_MAX_SCANLINE_BYTES (128ULL * 1024ULL * 1024ULL)
#define FC_MAX_DECODED_STRIP_BYTES (512ULL * 1024ULL * 1024ULL)

typedef struct {
  uint32_t width;
  uint32_t height;
  uint16_t bits_per_sample;
  uint16_t samples_per_pixel;
  uint16_t sample_format;
  uint16_t photometric;
  uint16_t compression;
  uint16_t orientation;
  uint16_t page_count;
  float x_resolution_dpi;
  float y_resolution_dpi;
  int has_icc;
} FramecutInfo;

static TIFF *source_tiff = NULL;
static FramecutInfo source_info;
static uint8_t *preview_pixels = NULL;
static uint32_t preview_width = 0;
static uint32_t preview_height = 0;
static uint8_t *decoded_strip_pixels = NULL;
static uint64_t decoded_strip_capacity = 0;
static uint64_t decoded_strip_bytes = 0;
static uint32_t decoded_strip_index = 0;
static uint32_t decoded_strip_first_row = 0;
static uint32_t decoded_strip_row_count = 0;
static int decoded_strip_valid = 0;
static char last_error[768] = "";

static void clear_error(void) { last_error[0] = '\0'; }

static void set_error(const char *message) {
  snprintf(last_error, sizeof(last_error), "%s", message);
}

static void set_errorf(const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(last_error, sizeof(last_error), format, arguments);
  va_end(arguments);
}

static void libtiff_error_handler(const char *module, const char *format,
                                  va_list arguments) {
  size_t offset = 0;
  if (module && module[0]) {
    offset = (size_t)snprintf(last_error, sizeof(last_error), "%s: ", module);
    if (offset >= sizeof(last_error)) {
      offset = sizeof(last_error) - 1;
    }
  }
  vsnprintf(last_error + offset, sizeof(last_error) - offset, format,
            arguments);
}

static void libtiff_warning_handler(const char *module, const char *format,
                                    va_list arguments) {
  (void)module;
  (void)format;
  (void)arguments;
}

static int checked_size_product(uint64_t left, uint64_t right,
                                uint64_t maximum, uint64_t *result) {
  if (left != 0 && right > UINT64_MAX / left) {
    return 0;
  }
  *result = left * right;
  return *result <= maximum;
}

static void free_preview(void) {
  free(preview_pixels);
  preview_pixels = NULL;
  preview_width = 0;
  preview_height = 0;
}

static void free_decoded_strip(void) {
  free(decoded_strip_pixels);
  decoded_strip_pixels = NULL;
  decoded_strip_capacity = 0;
  decoded_strip_bytes = 0;
  decoded_strip_index = 0;
  decoded_strip_first_row = 0;
  decoded_strip_row_count = 0;
  decoded_strip_valid = 0;
}

static void close_source(void) {
  free_preview();
  free_decoded_strip();
  if (source_tiff) {
    TIFFClose(source_tiff);
    source_tiff = NULL;
  }
  memset(&source_info, 0, sizeof(source_info));
}

static int compression_is_supported(uint16_t compression) {
  return compression == COMPRESSION_NONE || compression == COMPRESSION_LZW ||
         compression == COMPRESSION_ADOBE_DEFLATE ||
         compression == COMPRESSION_DEFLATE ||
         compression == COMPRESSION_PACKBITS;
}

static int read_source_info(TIFF *candidate, FramecutInfo *info) {
  uint16_t planar_configuration = PLANARCONFIG_CONTIG;
  uint16_t resolution_unit = RESUNIT_NONE;
  float x_resolution = 0;
  float y_resolution = 0;
  uint32_t icc_length = 0;
  void *icc_data = NULL;
  uint64_t scanline_size = 0;
  uint64_t expected_scanline_size = 0;

  memset(info, 0, sizeof(*info));
  if (!TIFFGetField(candidate, TIFFTAG_IMAGEWIDTH, &info->width) ||
      !TIFFGetField(candidate, TIFFTAG_IMAGELENGTH, &info->height)) {
    set_error("TIFF 缺少有效的图像宽度或高度。");
    return 0;
  }

  TIFFGetFieldDefaulted(candidate, TIFFTAG_BITSPERSAMPLE,
                        &info->bits_per_sample);
  TIFFGetFieldDefaulted(candidate, TIFFTAG_SAMPLESPERPIXEL,
                        &info->samples_per_pixel);
  TIFFGetFieldDefaulted(candidate, TIFFTAG_SAMPLEFORMAT, &info->sample_format);
  TIFFGetFieldDefaulted(candidate, TIFFTAG_PHOTOMETRIC, &info->photometric);
  TIFFGetFieldDefaulted(candidate, TIFFTAG_COMPRESSION, &info->compression);
  TIFFGetFieldDefaulted(candidate, TIFFTAG_ORIENTATION, &info->orientation);
  TIFFGetFieldDefaulted(candidate, TIFFTAG_PLANARCONFIG, &planar_configuration);

  if (info->width == 0 || info->height == 0) {
    set_error("TIFF 的图像尺寸不能为 0。");
    return 0;
  }
  if (info->bits_per_sample != 8 && info->bits_per_sample != 16) {
    set_errorf("首版只支持 8-bit 或 16-bit TIFF；这个文件是 %u-bit。",
               info->bits_per_sample);
    return 0;
  }
  if (info->samples_per_pixel != 1 && info->samples_per_pixel != 3) {
    set_errorf("首版只支持灰度或 RGB TIFF；这个文件有 %u 个通道。",
               info->samples_per_pixel);
    return 0;
  }
  if (info->sample_format != SAMPLEFORMAT_UINT) {
    set_error("首版只支持 unsigned integer TIFF。");
    return 0;
  }
  if (planar_configuration != PLANARCONFIG_CONTIG) {
    set_error("首版暂不支持 Planar Separate TIFF。");
    return 0;
  }
  if (info->orientation != ORIENTATION_TOPLEFT) {
    set_errorf("首版暂不处理 Orientation=%u 的 TIFF。",
               info->orientation);
    return 0;
  }
  if (info->samples_per_pixel == 3 &&
      info->photometric != PHOTOMETRIC_RGB) {
    set_error("三通道 TIFF 必须使用 RGB photometric。");
    return 0;
  }
  if (info->samples_per_pixel == 1 &&
      info->photometric != PHOTOMETRIC_MINISBLACK &&
      info->photometric != PHOTOMETRIC_MINISWHITE) {
    set_error("灰度 TIFF 必须使用 MinIsBlack 或 MinIsWhite photometric。");
    return 0;
  }
  if (!compression_is_supported(info->compression)) {
    set_errorf("首版暂不支持 Compression=%u 的 TIFF。",
               info->compression);
    return 0;
  }
  if (TIFFIsTiled(candidate)) {
    set_error("首版暂不支持 tiled TIFF；请先转换为 stripped TIFF。");
    return 0;
  }

  scanline_size = TIFFScanlineSize64(candidate);
  if (!checked_size_product(
          info->width,
          (uint64_t)info->samples_per_pixel * (info->bits_per_sample / 8),
          FC_MAX_SCANLINE_BYTES, &expected_scanline_size) ||
      scanline_size < expected_scanline_size ||
      scanline_size > FC_MAX_SCANLINE_BYTES) {
    set_error("TIFF 的单行数据尺寸异常或过大。");
    return 0;
  }

  info->page_count = TIFFNumberOfDirectories(candidate);
  if (info->page_count == 0) {
    info->page_count = 1;
  }
  if (!TIFFSetDirectory(candidate, 0)) {
    set_error("无法重新打开 TIFF 的第 1 页。");
    return 0;
  }

  TIFFGetFieldDefaulted(candidate, TIFFTAG_RESOLUTIONUNIT, &resolution_unit);
  TIFFGetField(candidate, TIFFTAG_XRESOLUTION, &x_resolution);
  TIFFGetField(candidate, TIFFTAG_YRESOLUTION, &y_resolution);
  if (resolution_unit == RESUNIT_CENTIMETER) {
    x_resolution *= 2.54f;
    y_resolution *= 2.54f;
  } else if (resolution_unit == RESUNIT_NONE) {
    x_resolution = 0;
    y_resolution = 0;
  }
  info->x_resolution_dpi = x_resolution;
  info->y_resolution_dpi = y_resolution;
  info->has_icc =
      TIFFGetField(candidate, TIFFTAG_ICCPROFILE, &icc_length, &icc_data) &&
      icc_length > 0 && icc_data;
  return 1;
}

EMSCRIPTEN_KEEPALIVE
int fc_open(const char *path) {
  TIFF *candidate = NULL;
  FramecutInfo candidate_info;
  clear_error();
  TIFFSetErrorHandler(libtiff_error_handler);
  TIFFSetWarningHandler(libtiff_warning_handler);

  candidate = TIFFOpen(path, "r");
  if (!candidate) {
    if (!last_error[0]) {
      set_error("无法打开这个 TIFF 文件。");
    }
    return 0;
  }
  if (!read_source_info(candidate, &candidate_info)) {
    TIFFClose(candidate);
    return 0;
  }

  free_preview();
  free_decoded_strip();
  if (source_tiff) {
    TIFFClose(source_tiff);
  }
  source_tiff = candidate;
  source_info = candidate_info;
  return 1;
}

EMSCRIPTEN_KEEPALIVE
void fc_close(void) { close_source(); }

EMSCRIPTEN_KEEPALIVE
const char *fc_last_error(void) {
  return last_error[0] ? last_error : "TIFF 引擎发生未知错误。";
}

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_width(void) { return source_info.width; }

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_height(void) { return source_info.height; }

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_bits_per_sample(void) {
  return source_info.bits_per_sample;
}

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_samples_per_pixel(void) {
  return source_info.samples_per_pixel;
}

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_photometric(void) { return source_info.photometric; }

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_compression(void) { return source_info.compression; }

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_orientation(void) { return source_info.orientation; }

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_page_count(void) { return source_info.page_count; }

EMSCRIPTEN_KEEPALIVE
double fc_get_x_resolution_dpi(void) {
  return (double)source_info.x_resolution_dpi;
}

EMSCRIPTEN_KEEPALIVE
double fc_get_y_resolution_dpi(void) {
  return (double)source_info.y_resolution_dpi;
}

EMSCRIPTEN_KEEPALIVE
int fc_get_has_icc(void) { return source_info.has_icc; }

static int read_source_row(uint32_t row, const uint8_t **row_pixels) {
  uint32_t strip = 0;
  uint32_t strip_count = 0;
  uint32_t rows_per_strip = 0;
  uint32_t rows_in_strip = 0;
  uint64_t first_row = 0;
  uint64_t scanline_size = 0;
  uint64_t required_bytes = 0;
  uint64_t reported_strip_size = 0;
  uint64_t row_offset = 0;
  tmsize_t bytes_read = 0;

  if (!source_tiff || !row_pixels || row >= source_info.height) {
    set_error("请求的 TIFF 行超出原图范围。");
    return 0;
  }

  strip = TIFFComputeStrip(source_tiff, row, 0);
  if (decoded_strip_valid && strip == decoded_strip_index &&
      row >= decoded_strip_first_row &&
      row - decoded_strip_first_row < decoded_strip_row_count) {
    scanline_size = TIFFScanlineSize64(source_tiff);
    row_offset =
        (uint64_t)(row - decoded_strip_first_row) * scanline_size;
    if (scanline_size == 0 || row_offset > decoded_strip_bytes ||
        scanline_size > decoded_strip_bytes - row_offset) {
      set_error("缓存的 TIFF strip 行范围无效。");
      decoded_strip_valid = 0;
      return 0;
    }
    *row_pixels = decoded_strip_pixels + row_offset;
    return 1;
  }

  strip_count = TIFFNumberOfStrips(source_tiff);
  TIFFGetFieldDefaulted(source_tiff, TIFFTAG_ROWSPERSTRIP, &rows_per_strip);
  if (rows_per_strip == 0 || strip >= strip_count) {
    set_error("TIFF 的 strip 布局无效。");
    return 0;
  }

  first_row = (uint64_t)strip * rows_per_strip;
  if (first_row >= source_info.height) {
    set_error("TIFF 的 strip 起始行超出原图范围。");
    return 0;
  }
  rows_in_strip =
      (uint32_t)((uint64_t)source_info.height - first_row < rows_per_strip
                     ? (uint64_t)source_info.height - first_row
                     : rows_per_strip);
  scanline_size = TIFFScanlineSize64(source_tiff);
  if (!checked_size_product(scanline_size, rows_in_strip,
                            FC_MAX_DECODED_STRIP_BYTES, &required_bytes)) {
    set_error(
        "源 TIFF 的单个解码 strip 超过 512 MiB；浏览器单文件版暂不处理。");
    return 0;
  }
  reported_strip_size = TIFFVStripSize64(source_tiff, rows_in_strip);
  if (required_bytes == 0 || reported_strip_size < required_bytes) {
    set_error("TIFF 的 strip 解码尺寸与 scanline 布局不一致。");
    return 0;
  }

  if (decoded_strip_capacity < required_bytes) {
    uint8_t *next_pixels =
        (uint8_t *)realloc(decoded_strip_pixels, (size_t)required_bytes);
    if (!next_pixels) {
      set_error("内存不足，无法解码 TIFF strip。");
      return 0;
    }
    decoded_strip_pixels = next_pixels;
    decoded_strip_capacity = required_bytes;
  }

  decoded_strip_valid = 0;
  bytes_read = TIFFReadEncodedStrip(source_tiff, strip, decoded_strip_pixels,
                                    (tmsize_t)required_bytes);
  if (bytes_read < 0) {
    if (!last_error[0]) {
      set_errorf("解码 TIFF strip %u 失败。", strip);
    }
    return 0;
  }
  if ((uint64_t)bytes_read < required_bytes) {
    set_errorf("TIFF strip %u 只解码出 %llu 字节，预期 %llu 字节。", strip,
               (unsigned long long)bytes_read,
               (unsigned long long)required_bytes);
    return 0;
  }

  decoded_strip_bytes = (uint64_t)bytes_read;
  decoded_strip_index = strip;
  decoded_strip_first_row = (uint32_t)first_row;
  decoded_strip_row_count = rows_in_strip;
  decoded_strip_valid = 1;
  row_offset = (uint64_t)(row - decoded_strip_first_row) * scanline_size;
  if (row_offset > decoded_strip_bytes ||
      scanline_size > decoded_strip_bytes - row_offset) {
    set_error("解码后的 TIFF strip 行范围无效。");
    decoded_strip_valid = 0;
    return 0;
  }
  *row_pixels = decoded_strip_pixels + row_offset;
  return 1;
}

EMSCRIPTEN_KEEPALIVE
int fc_make_preview(uint32_t maximum_dimension) {
  uint64_t pixel_count = 0;
  uint64_t preview_bytes = 0;

  clear_error();
  free_preview();
  if (!source_tiff) {
    set_error("请先打开一个 TIFF 文件。");
    return 0;
  }
  if (maximum_dimension == 0 || maximum_dimension > 4096) {
    set_error("预览尺寸必须在 1 到 4096 像素之间。");
    return 0;
  }
  if (!TIFFSetDirectory(source_tiff, 0)) {
    set_error("无法重新读取 TIFF 的第 1 页。");
    return 0;
  }

  if (source_info.width >= source_info.height) {
    preview_width =
        source_info.width > maximum_dimension ? maximum_dimension
                                              : source_info.width;
    preview_height = (uint32_t)(((uint64_t)source_info.height * preview_width +
                                 source_info.width / 2) /
                                source_info.width);
  } else {
    preview_height =
        source_info.height > maximum_dimension ? maximum_dimension
                                               : source_info.height;
    preview_width = (uint32_t)(((uint64_t)source_info.width * preview_height +
                                source_info.height / 2) /
                               source_info.height);
  }
  if (preview_width == 0) {
    preview_width = 1;
  }
  if (preview_height == 0) {
    preview_height = 1;
  }

  if (!checked_size_product(preview_width, preview_height, UINT32_MAX,
                            &pixel_count) ||
      !checked_size_product(pixel_count, 4, UINT32_MAX, &preview_bytes)) {
    set_error("预览图尺寸过大。");
    free_preview();
    return 0;
  }

  preview_pixels = (uint8_t *)malloc((size_t)preview_bytes);
  if (!preview_pixels) {
    set_error("内存不足，无法生成预览。");
    free_preview();
    return 0;
  }

  for (uint32_t output_y = 0; output_y < preview_height; output_y++) {
    uint32_t source_y =
        (uint32_t)(((uint64_t)output_y * source_info.height) / preview_height);
    const uint8_t *scanline = NULL;
    if (!read_source_row(source_y, &scanline)) {
      free_preview();
      return 0;
    }

    for (uint32_t output_x = 0; output_x < preview_width; output_x++) {
      uint32_t source_x = (uint32_t)(((uint64_t)output_x * source_info.width) /
                                     preview_width);
      uint8_t red = 0;
      uint8_t green = 0;
      uint8_t blue = 0;

      if (source_info.bits_per_sample == 8) {
        const uint8_t *sample =
            scanline + (uint64_t)source_x * source_info.samples_per_pixel;
        if (source_info.samples_per_pixel == 3) {
          red = sample[0];
          green = sample[1];
          blue = sample[2];
        } else {
          uint8_t value = sample[0];
          if (source_info.photometric == PHOTOMETRIC_MINISWHITE) {
            value = (uint8_t)(255 - value);
          }
          red = green = blue = value;
        }
      } else {
        const uint16_t *samples = (const uint16_t *)scanline;
        const uint16_t *sample =
            samples + (uint64_t)source_x * source_info.samples_per_pixel;
        if (source_info.samples_per_pixel == 3) {
          red = (uint8_t)(sample[0] >> 8);
          green = (uint8_t)(sample[1] >> 8);
          blue = (uint8_t)(sample[2] >> 8);
        } else {
          uint16_t value = sample[0];
          if (source_info.photometric == PHOTOMETRIC_MINISWHITE) {
            value = (uint16_t)(65535 - value);
          }
          red = green = blue = (uint8_t)(value >> 8);
        }
      }

      uint8_t *target =
          preview_pixels + ((uint64_t)output_y * preview_width + output_x) * 4;
      target[0] = red;
      target[1] = green;
      target[2] = blue;
      target[3] = 255;
    }
  }

  return 1;
}

EMSCRIPTEN_KEEPALIVE
uintptr_t fc_get_preview_pointer(void) {
  return (uintptr_t)preview_pixels;
}

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_preview_width(void) { return preview_width; }

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_preview_height(void) { return preview_height; }

EMSCRIPTEN_KEEPALIVE
void fc_free_preview(void) { free_preview(); }

static int copy_string_tag(TIFF *output, ttag_t tag) {
  char *value = NULL;
  if (TIFFGetField(source_tiff, tag, &value) && value &&
      !TIFFSetField(output, tag, value)) {
    set_errorf("无法保留 TIFF Tag %u。", (unsigned int)tag);
    return 0;
  }
  return 1;
}

static int copy_icc_profile(TIFF *output) {
  uint32_t length = 0;
  void *data = NULL;
  if (TIFFGetField(source_tiff, TIFFTAG_ICCPROFILE, &length, &data) && length &&
      data && !TIFFSetField(output, TIFFTAG_ICCPROFILE, length, data)) {
    set_error("无法保留源 TIFF 的 ICC Profile。");
    return 0;
  }
  return 1;
}

static int copy_resolution_tags(TIFF *output) {
  uint16_t unit = RESUNIT_NONE;
  float x_resolution = 0;
  float y_resolution = 0;
  TIFFGetFieldDefaulted(source_tiff, TIFFTAG_RESOLUTIONUNIT, &unit);
  if (TIFFGetField(source_tiff, TIFFTAG_XRESOLUTION, &x_resolution) &&
      !TIFFSetField(output, TIFFTAG_XRESOLUTION, x_resolution)) {
    set_error("无法保留源 TIFF 的 XResolution。");
    return 0;
  }
  if (TIFFGetField(source_tiff, TIFFTAG_YRESOLUTION, &y_resolution) &&
      !TIFFSetField(output, TIFFTAG_YRESOLUTION, y_resolution)) {
    set_error("无法保留源 TIFF 的 YResolution。");
    return 0;
  }
  if (!TIFFSetField(output, TIFFTAG_RESOLUTIONUNIT, unit)) {
    set_error("无法保留源 TIFF 的 ResolutionUnit。");
    return 0;
  }
  return 1;
}

static int copy_chromaticity_tags(TIFF *output) {
  float *values = NULL;
  if (TIFFGetField(source_tiff, TIFFTAG_WHITEPOINT, &values) && values &&
      !TIFFSetField(output, TIFFTAG_WHITEPOINT, values)) {
    set_error("无法保留源 TIFF 的 WhitePoint。");
    return 0;
  }
  values = NULL;
  if (TIFFGetField(source_tiff, TIFFTAG_PRIMARYCHROMATICITIES, &values) &&
      values && !TIFFSetField(output, TIFFTAG_PRIMARYCHROMATICITIES, values)) {
    set_error("无法保留源 TIFF 的 PrimaryChromaticities。");
    return 0;
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE
int fc_export_crop(uint32_t x, uint32_t y, uint32_t width, uint32_t height,
                   const char *output_path) {
  TIFF *output = NULL;
  const uint8_t *source_scanline = NULL;
  uint8_t *output_scanline = NULL;
  uint64_t source_scanline_bytes = 0;
  uint64_t output_scanline_bytes = 0;
  uint64_t raw_crop_bytes = 0;
  uint64_t source_x_bytes = 0;
  uint32_t rows_per_strip = 1;
  int success = 0;

  clear_error();
  if (!source_tiff) {
    set_error("请先打开一个 TIFF 文件。");
    return 0;
  }
  if (width == 0 || height == 0 || x >= source_info.width ||
      y >= source_info.height || (uint64_t)x + width > source_info.width ||
      (uint64_t)y + height > source_info.height) {
    set_error("裁切区域超出原图范围。");
    return 0;
  }
  if (!output_path || !output_path[0]) {
    set_error("输出路径不能为空。");
    return 0;
  }

  if (!checked_size_product(
          width,
          (uint64_t)source_info.samples_per_pixel *
              (source_info.bits_per_sample / 8),
          FC_MAX_SCANLINE_BYTES, &output_scanline_bytes) ||
      !checked_size_product(output_scanline_bytes, height,
                            FC_MAX_RAW_CROP_BYTES, &raw_crop_bytes)) {
    set_error("单个裁切区域的裸像素超过 384 MiB。");
    return 0;
  }
  source_scanline_bytes = TIFFScanlineSize64(source_tiff);
  source_x_bytes =
      (uint64_t)x * source_info.samples_per_pixel *
      (source_info.bits_per_sample / 8);
  if (source_scanline_bytes == 0 ||
      source_x_bytes + output_scanline_bytes > source_scanline_bytes) {
    set_error("TIFF 的 scanline 布局与图像标签不一致。");
    return 0;
  }
  output = TIFFOpen(output_path, "wl");
  if (!output) {
    if (!last_error[0]) {
      set_error("无法创建输出 TIFF。");
    }
    return 0;
  }

#define SET_REQUIRED_FIELD(tag, value)                                      \
  do {                                                                       \
    if (!TIFFSetField(output, (tag), (value))) {                             \
      set_errorf("无法写入必要的 TIFF Tag %u。", (unsigned int)(tag));       \
      goto cleanup;                                                          \
    }                                                                        \
  } while (0)

  SET_REQUIRED_FIELD(TIFFTAG_IMAGEWIDTH, width);
  SET_REQUIRED_FIELD(TIFFTAG_IMAGELENGTH, height);
  SET_REQUIRED_FIELD(TIFFTAG_BITSPERSAMPLE, source_info.bits_per_sample);
  SET_REQUIRED_FIELD(TIFFTAG_SAMPLESPERPIXEL, source_info.samples_per_pixel);
  SET_REQUIRED_FIELD(TIFFTAG_SAMPLEFORMAT, SAMPLEFORMAT_UINT);
  SET_REQUIRED_FIELD(TIFFTAG_PHOTOMETRIC, source_info.photometric);
  SET_REQUIRED_FIELD(TIFFTAG_PLANARCONFIG, PLANARCONFIG_CONTIG);
  SET_REQUIRED_FIELD(TIFFTAG_ORIENTATION, ORIENTATION_TOPLEFT);
  SET_REQUIRED_FIELD(TIFFTAG_COMPRESSION, COMPRESSION_ADOBE_DEFLATE);
  SET_REQUIRED_FIELD(TIFFTAG_PREDICTOR, PREDICTOR_HORIZONTAL);

  rows_per_strip =
      output_scanline_bytes >= 1024 * 1024
          ? 1
          : (uint32_t)((1024 * 1024) / output_scanline_bytes);
  if (rows_per_strip == 0) {
    rows_per_strip = 1;
  }
  if (rows_per_strip > height) {
    rows_per_strip = height;
  }
  SET_REQUIRED_FIELD(TIFFTAG_ROWSPERSTRIP, rows_per_strip);
#ifdef TIFFTAG_ZIPQUALITY
  TIFFSetField(output, TIFFTAG_ZIPQUALITY, 6);
#endif

  if (!copy_resolution_tags(output) || !copy_chromaticity_tags(output) ||
      !copy_string_tag(output, TIFFTAG_DOCUMENTNAME) ||
      !copy_string_tag(output, TIFFTAG_IMAGEDESCRIPTION) ||
      !copy_string_tag(output, TIFFTAG_MAKE) ||
      !copy_string_tag(output, TIFFTAG_MODEL) ||
      !copy_string_tag(output, TIFFTAG_SOFTWARE) ||
      !copy_string_tag(output, TIFFTAG_DATETIME) ||
      !copy_string_tag(output, TIFFTAG_ARTIST) ||
      !copy_string_tag(output, TIFFTAG_HOSTCOMPUTER) ||
      !copy_string_tag(output, TIFFTAG_COPYRIGHT) ||
      !copy_icc_profile(output)) {
    goto cleanup;
  }

  output_scanline = (uint8_t *)malloc((size_t)output_scanline_bytes);
  if (!output_scanline) {
    set_error("内存不足，无法建立 TIFF scanline 缓冲区。");
    goto cleanup;
  }

  for (uint32_t output_y = 0; output_y < height; output_y++) {
    uint32_t source_y = y + output_y;
    if (!read_source_row(source_y, &source_scanline)) {
      goto cleanup;
    }
    memcpy(output_scanline, source_scanline + source_x_bytes,
           (size_t)output_scanline_bytes);
    if (TIFFWriteScanline(output, output_scanline, output_y, 0) < 0) {
      if (!last_error[0]) {
        set_errorf("写入输出 TIFF 第 %u 行失败。", output_y);
      }
      goto cleanup;
    }
  }

  if (!TIFFFlush(output)) {
    if (!last_error[0]) {
      set_error("刷新输出 TIFF 失败。");
    }
    goto cleanup;
  }
  success = 1;

cleanup:
  free(output_scanline);
  TIFFClose(output);
  if (!success) {
    remove(output_path);
  }
  return success;

#undef SET_REQUIRED_FIELD
}
