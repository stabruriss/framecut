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

static int orientation_swaps_axes(uint16_t orientation) {
  return orientation >= ORIENTATION_LEFTTOP &&
         orientation <= ORIENTATION_LEFTBOT;
}

static uint32_t oriented_width(uint32_t stored_width, uint32_t stored_height,
                               uint16_t orientation) {
  return orientation_swaps_axes(orientation) ? stored_height : stored_width;
}

static uint32_t oriented_height(uint32_t stored_width, uint32_t stored_height,
                                uint16_t orientation) {
  return orientation_swaps_axes(orientation) ? stored_width : stored_height;
}

static void oriented_to_stored(uint32_t oriented_x, uint32_t oriented_y,
                               uint32_t stored_width, uint32_t stored_height,
                               uint16_t orientation, uint32_t *stored_x,
                               uint32_t *stored_y) {
  switch (orientation) {
  case ORIENTATION_TOPRIGHT:
    *stored_x = stored_width - 1 - oriented_x;
    *stored_y = oriented_y;
    break;
  case ORIENTATION_BOTRIGHT:
    *stored_x = stored_width - 1 - oriented_x;
    *stored_y = stored_height - 1 - oriented_y;
    break;
  case ORIENTATION_BOTLEFT:
    *stored_x = oriented_x;
    *stored_y = stored_height - 1 - oriented_y;
    break;
  case ORIENTATION_LEFTTOP:
    *stored_x = oriented_y;
    *stored_y = oriented_x;
    break;
  case ORIENTATION_RIGHTTOP:
    *stored_x = oriented_y;
    *stored_y = stored_height - 1 - oriented_x;
    break;
  case ORIENTATION_RIGHTBOT:
    *stored_x = stored_width - 1 - oriented_y;
    *stored_y = stored_height - 1 - oriented_x;
    break;
  case ORIENTATION_LEFTBOT:
    *stored_x = stored_width - 1 - oriented_y;
    *stored_y = oriented_x;
    break;
  case ORIENTATION_TOPLEFT:
  default:
    *stored_x = oriented_x;
    *stored_y = oriented_y;
    break;
  }
}

static void stored_to_oriented(uint32_t stored_x, uint32_t stored_y,
                               uint32_t stored_width, uint32_t stored_height,
                               uint16_t orientation, uint32_t *oriented_x,
                               uint32_t *oriented_y) {
  switch (orientation) {
  case ORIENTATION_TOPRIGHT:
    *oriented_x = stored_width - 1 - stored_x;
    *oriented_y = stored_y;
    break;
  case ORIENTATION_BOTRIGHT:
    *oriented_x = stored_width - 1 - stored_x;
    *oriented_y = stored_height - 1 - stored_y;
    break;
  case ORIENTATION_BOTLEFT:
    *oriented_x = stored_x;
    *oriented_y = stored_height - 1 - stored_y;
    break;
  case ORIENTATION_LEFTTOP:
    *oriented_x = stored_y;
    *oriented_y = stored_x;
    break;
  case ORIENTATION_RIGHTTOP:
    *oriented_x = stored_height - 1 - stored_y;
    *oriented_y = stored_x;
    break;
  case ORIENTATION_RIGHTBOT:
    *oriented_x = stored_height - 1 - stored_y;
    *oriented_y = stored_width - 1 - stored_x;
    break;
  case ORIENTATION_LEFTBOT:
    *oriented_x = stored_y;
    *oriented_y = stored_width - 1 - stored_x;
    break;
  case ORIENTATION_TOPLEFT:
  default:
    *oriented_x = stored_x;
    *oriented_y = stored_y;
    break;
  }
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
    set_error("TIFF width or height is missing.");
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
    set_error("TIFF dimensions cannot be zero.");
    return 0;
  }
  if (info->bits_per_sample != 8 && info->bits_per_sample != 16) {
    set_errorf("Only 8-bit and 16-bit TIFFs are supported. This file is %u-bit.",
               info->bits_per_sample);
    return 0;
  }
  if (info->samples_per_pixel != 1 && info->samples_per_pixel != 3) {
    set_errorf("Only grayscale and RGB TIFFs are supported. This file has %u channels.",
               info->samples_per_pixel);
    return 0;
  }
  if (info->sample_format != SAMPLEFORMAT_UINT) {
    set_error("Only unsigned integer TIFFs are supported.");
    return 0;
  }
  if (planar_configuration != PLANARCONFIG_CONTIG) {
    set_error("Planar Separate TIFFs are not supported.");
    return 0;
  }
  if (info->orientation < ORIENTATION_TOPLEFT ||
      info->orientation > ORIENTATION_LEFTBOT) {
    set_errorf("TIFF Orientation=%u is invalid. Expected 1-8.",
               info->orientation);
    return 0;
  }
  if (info->samples_per_pixel == 3 &&
      info->photometric != PHOTOMETRIC_RGB) {
    set_error("A three-channel TIFF must use RGB photometric.");
    return 0;
  }
  if (info->samples_per_pixel == 1 &&
      info->photometric != PHOTOMETRIC_MINISBLACK &&
      info->photometric != PHOTOMETRIC_MINISWHITE) {
    set_error("A grayscale TIFF must use MinIsBlack or MinIsWhite photometric.");
    return 0;
  }
  if (!compression_is_supported(info->compression)) {
    set_errorf("TIFF Compression=%u is not supported.",
               info->compression);
    return 0;
  }
  if (TIFFIsTiled(candidate)) {
    set_error("Tiled TIFFs are not supported. Convert to stripped TIFF first.");
    return 0;
  }

  scanline_size = TIFFScanlineSize64(candidate);
  if (!checked_size_product(
          info->width,
          (uint64_t)info->samples_per_pixel * (info->bits_per_sample / 8),
          FC_MAX_SCANLINE_BYTES, &expected_scanline_size) ||
      scanline_size < expected_scanline_size ||
      scanline_size > FC_MAX_SCANLINE_BYTES) {
    set_error("The TIFF scanline size is invalid or too large.");
    return 0;
  }

  info->page_count = TIFFNumberOfDirectories(candidate);
  if (info->page_count == 0) {
    info->page_count = 1;
  }
  if (!TIFFSetDirectory(candidate, 0)) {
    set_error("Could not reopen TIFF page 1.");
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
      set_error("Could not open this TIFF.");
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
  return last_error[0] ? last_error : "Unknown TIFF engine error.";
}

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_width(void) {
  return oriented_width(source_info.width, source_info.height,
                        source_info.orientation);
}

EMSCRIPTEN_KEEPALIVE
uint32_t fc_get_height(void) {
  return oriented_height(source_info.width, source_info.height,
                         source_info.orientation);
}

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
  return (double)(orientation_swaps_axes(source_info.orientation)
                      ? source_info.y_resolution_dpi
                      : source_info.x_resolution_dpi);
}

EMSCRIPTEN_KEEPALIVE
double fc_get_y_resolution_dpi(void) {
  return (double)(orientation_swaps_axes(source_info.orientation)
                      ? source_info.x_resolution_dpi
                      : source_info.y_resolution_dpi);
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
    set_error("The requested TIFF row is outside the image.");
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
      set_error("The cached TIFF strip range is invalid.");
      decoded_strip_valid = 0;
      return 0;
    }
    *row_pixels = decoded_strip_pixels + row_offset;
    return 1;
  }

  strip_count = TIFFNumberOfStrips(source_tiff);
  TIFFGetFieldDefaulted(source_tiff, TIFFTAG_ROWSPERSTRIP, &rows_per_strip);
  if (rows_per_strip == 0 || strip >= strip_count) {
    set_error("The TIFF strip layout is invalid.");
    return 0;
  }

  first_row = (uint64_t)strip * rows_per_strip;
  if (first_row >= source_info.height) {
    set_error("The TIFF strip starts outside the image.");
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
        "A decoded TIFF strip exceeds the 512 MiB limit.");
    return 0;
  }
  reported_strip_size = TIFFVStripSize64(source_tiff, rows_in_strip);
  if (required_bytes == 0 || reported_strip_size < required_bytes) {
    set_error("The decoded strip size does not match the scanline layout.");
    return 0;
  }

  if (decoded_strip_capacity < required_bytes) {
    uint8_t *next_pixels =
        (uint8_t *)realloc(decoded_strip_pixels, (size_t)required_bytes);
    if (!next_pixels) {
      set_error("Not enough memory to decode the TIFF strip.");
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
      set_errorf("Could not decode TIFF strip %u.", strip);
    }
    return 0;
  }
  if ((uint64_t)bytes_read < required_bytes) {
    set_errorf("TIFF strip %u decoded %llu bytes; expected %llu.", strip,
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
    set_error("The decoded TIFF strip range is invalid.");
    decoded_strip_valid = 0;
    return 0;
  }
  *row_pixels = decoded_strip_pixels + row_offset;
  return 1;
}

EMSCRIPTEN_KEEPALIVE
int fc_make_preview(uint32_t maximum_dimension) {
  uint8_t *stored_preview_pixels = NULL;
  uint32_t stored_preview_width = 0;
  uint32_t stored_preview_height = 0;
  uint64_t pixel_count = 0;
  uint64_t preview_bytes = 0;

  clear_error();
  free_preview();
  if (!source_tiff) {
    set_error("Open a TIFF first.");
    return 0;
  }
  if (maximum_dimension == 0 || maximum_dimension > 4096) {
    set_error("Preview size must be 1-4096 pixels.");
    return 0;
  }
  if (!TIFFSetDirectory(source_tiff, 0)) {
    set_error("Could not read TIFF page 1 again.");
    return 0;
  }

  if (source_info.width >= source_info.height) {
    stored_preview_width =
        source_info.width > maximum_dimension ? maximum_dimension
                                              : source_info.width;
    stored_preview_height =
        (uint32_t)(((uint64_t)source_info.height * stored_preview_width +
                    source_info.width / 2) /
                   source_info.width);
  } else {
    stored_preview_height =
        source_info.height > maximum_dimension ? maximum_dimension
                                               : source_info.height;
    stored_preview_width =
        (uint32_t)(((uint64_t)source_info.width * stored_preview_height +
                    source_info.height / 2) /
                   source_info.height);
  }
  if (stored_preview_width == 0) {
    stored_preview_width = 1;
  }
  if (stored_preview_height == 0) {
    stored_preview_height = 1;
  }
  preview_width =
      oriented_width(stored_preview_width, stored_preview_height,
                     source_info.orientation);
  preview_height =
      oriented_height(stored_preview_width, stored_preview_height,
                      source_info.orientation);

  if (!checked_size_product(stored_preview_width, stored_preview_height,
                            UINT32_MAX, &pixel_count) ||
      !checked_size_product(pixel_count, 4, UINT32_MAX, &preview_bytes)) {
    set_error("The preview is too large.");
    free_preview();
    return 0;
  }

  preview_pixels = (uint8_t *)malloc((size_t)preview_bytes);
  if (!preview_pixels) {
    set_error("Not enough memory to build the preview.");
    free_preview();
    return 0;
  }
  stored_preview_pixels = preview_pixels;
  if (source_info.orientation != ORIENTATION_TOPLEFT) {
    stored_preview_pixels = (uint8_t *)malloc((size_t)preview_bytes);
    if (!stored_preview_pixels) {
      set_error("Not enough memory to orient the TIFF preview.");
      free_preview();
      return 0;
    }
  }

  for (uint32_t output_y = 0; output_y < stored_preview_height; output_y++) {
    uint32_t source_y =
        (uint32_t)(((uint64_t)output_y * source_info.height) /
                   stored_preview_height);
    const uint8_t *scanline = NULL;
    if (!read_source_row(source_y, &scanline)) {
      if (stored_preview_pixels != preview_pixels) {
        free(stored_preview_pixels);
      }
      free_preview();
      return 0;
    }

    for (uint32_t output_x = 0; output_x < stored_preview_width; output_x++) {
      uint32_t source_x = (uint32_t)(((uint64_t)output_x * source_info.width) /
                                     stored_preview_width);
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
          stored_preview_pixels +
          ((uint64_t)output_y * stored_preview_width + output_x) * 4;
      target[0] = red;
      target[1] = green;
      target[2] = blue;
      target[3] = 255;
    }
  }

  if (stored_preview_pixels != preview_pixels) {
    for (uint32_t stored_y = 0; stored_y < stored_preview_height; stored_y++) {
      for (uint32_t stored_x = 0; stored_x < stored_preview_width; stored_x++) {
        uint32_t display_x = 0;
        uint32_t display_y = 0;
        stored_to_oriented(stored_x, stored_y, stored_preview_width,
                           stored_preview_height, source_info.orientation,
                           &display_x, &display_y);
        memcpy(preview_pixels +
                   ((uint64_t)display_y * preview_width + display_x) * 4,
               stored_preview_pixels +
                   ((uint64_t)stored_y * stored_preview_width + stored_x) * 4,
               4);
      }
    }
    free(stored_preview_pixels);
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
    set_errorf("Could not preserve TIFF Tag %u.", (unsigned int)tag);
    return 0;
  }
  return 1;
}

static int copy_icc_profile(TIFF *output) {
  uint32_t length = 0;
  void *data = NULL;
  if (TIFFGetField(source_tiff, TIFFTAG_ICCPROFILE, &length, &data) && length &&
      data && !TIFFSetField(output, TIFFTAG_ICCPROFILE, length, data)) {
    set_error("Could not preserve the TIFF ICC profile.");
    return 0;
  }
  return 1;
}

static int copy_resolution_tags(TIFF *output) {
  uint16_t unit = RESUNIT_NONE;
  float x_resolution = 0;
  float y_resolution = 0;
  int has_x_resolution = 0;
  int has_y_resolution = 0;
  TIFFGetFieldDefaulted(source_tiff, TIFFTAG_RESOLUTIONUNIT, &unit);
  has_x_resolution =
      TIFFGetField(source_tiff, TIFFTAG_XRESOLUTION, &x_resolution);
  has_y_resolution =
      TIFFGetField(source_tiff, TIFFTAG_YRESOLUTION, &y_resolution);
  if (orientation_swaps_axes(source_info.orientation)) {
    float swap = x_resolution;
    x_resolution = y_resolution;
    y_resolution = swap;
    int has_swap = has_x_resolution;
    has_x_resolution = has_y_resolution;
    has_y_resolution = has_swap;
  }
  if (has_x_resolution &&
      !TIFFSetField(output, TIFFTAG_XRESOLUTION, x_resolution)) {
    set_error("Could not preserve TIFF XResolution.");
    return 0;
  }
  if (has_y_resolution &&
      !TIFFSetField(output, TIFFTAG_YRESOLUTION, y_resolution)) {
    set_error("Could not preserve TIFF YResolution.");
    return 0;
  }
  if (!TIFFSetField(output, TIFFTAG_RESOLUTIONUNIT, unit)) {
    set_error("Could not preserve TIFF ResolutionUnit.");
    return 0;
  }
  return 1;
}

static int copy_chromaticity_tags(TIFF *output) {
  float *values = NULL;
  if (TIFFGetField(source_tiff, TIFFTAG_WHITEPOINT, &values) && values &&
      !TIFFSetField(output, TIFFTAG_WHITEPOINT, values)) {
    set_error("Could not preserve TIFF WhitePoint.");
    return 0;
  }
  values = NULL;
  if (TIFFGetField(source_tiff, TIFFTAG_PRIMARYCHROMATICITIES, &values) &&
      values && !TIFFSetField(output, TIFFTAG_PRIMARYCHROMATICITIES, values)) {
    set_error("Could not preserve TIFF PrimaryChromaticities.");
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
  uint8_t *output_pixels = NULL;
  uint64_t bytes_per_pixel = 0;
  uint64_t source_scanline_bytes = 0;
  uint64_t output_scanline_bytes = 0;
  uint64_t raw_crop_bytes = 0;
  uint64_t source_x_bytes = 0;
  uint32_t display_width = 0;
  uint32_t display_height = 0;
  uint32_t rows_per_strip = 1;
  int success = 0;

  clear_error();
  if (!source_tiff) {
    set_error("Open a TIFF first.");
    return 0;
  }
  display_width =
      oriented_width(source_info.width, source_info.height,
                     source_info.orientation);
  display_height =
      oriented_height(source_info.width, source_info.height,
                      source_info.orientation);
  if (width == 0 || height == 0 || x >= display_width ||
      y >= display_height || (uint64_t)x + width > display_width ||
      (uint64_t)y + height > display_height) {
    set_error("The frame is outside the source image.");
    return 0;
  }
  if (!output_path || !output_path[0]) {
    set_error("The output path is empty.");
    return 0;
  }

  bytes_per_pixel = (uint64_t)source_info.samples_per_pixel *
                    (source_info.bits_per_sample / 8);
  if (!checked_size_product(
          width, bytes_per_pixel,
          FC_MAX_SCANLINE_BYTES, &output_scanline_bytes) ||
      !checked_size_product(output_scanline_bytes, height,
                            FC_MAX_RAW_CROP_BYTES, &raw_crop_bytes)) {
    set_error("One frame exceeds the 384 MiB raw-pixel limit.");
    return 0;
  }
  source_scanline_bytes = TIFFScanlineSize64(source_tiff);
  if (source_scanline_bytes == 0 ||
      (uint64_t)source_info.width * bytes_per_pixel >
          source_scanline_bytes) {
    set_error("The TIFF scanline layout does not match its tags.");
    return 0;
  }
  if (source_info.orientation == ORIENTATION_TOPLEFT) {
    source_x_bytes = (uint64_t)x * bytes_per_pixel;
  }
  output = TIFFOpen(output_path, "wl");
  if (!output) {
    if (!last_error[0]) {
      set_error("Could not create the output TIFF.");
    }
    return 0;
  }

#define SET_REQUIRED_FIELD(tag, value)                                      \
  do {                                                                       \
    if (!TIFFSetField(output, (tag), (value))) {                             \
      set_errorf("Could not write required TIFF Tag %u.",                    \
                 (unsigned int)(tag));                                        \
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

  if (source_info.orientation == ORIENTATION_TOPLEFT) {
    output_scanline = (uint8_t *)malloc((size_t)output_scanline_bytes);
    if (!output_scanline) {
      set_error("Not enough memory for the TIFF scanline buffer.");
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
          set_errorf("Could not write output TIFF row %u.", output_y);
        }
        goto cleanup;
      }
    }
  } else {
    uint32_t display_corner_x[4] = {x, x + width - 1, x,
                                    x + width - 1};
    uint32_t display_corner_y[4] = {y, y, y + height - 1,
                                    y + height - 1};
    uint32_t stored_min_x = UINT32_MAX;
    uint32_t stored_min_y = UINT32_MAX;
    uint32_t stored_max_x = 0;
    uint32_t stored_max_y = 0;
    uint64_t copied_pixels = 0;

    output_pixels = (uint8_t *)malloc((size_t)raw_crop_bytes);
    if (!output_pixels) {
      set_error("Not enough memory for the oriented frame buffer.");
      goto cleanup;
    }

    for (uint32_t corner = 0; corner < 4; corner++) {
      uint32_t stored_x = 0;
      uint32_t stored_y = 0;
      oriented_to_stored(display_corner_x[corner], display_corner_y[corner],
                         source_info.width, source_info.height,
                         source_info.orientation, &stored_x, &stored_y);
      if (stored_x < stored_min_x) {
        stored_min_x = stored_x;
      }
      if (stored_x > stored_max_x) {
        stored_max_x = stored_x;
      }
      if (stored_y < stored_min_y) {
        stored_min_y = stored_y;
      }
      if (stored_y > stored_max_y) {
        stored_max_y = stored_y;
      }
    }

    for (uint64_t stored_y_cursor = stored_min_y;
         stored_y_cursor <= stored_max_y; stored_y_cursor++) {
      uint32_t stored_y = (uint32_t)stored_y_cursor;
      if (!read_source_row(stored_y, &source_scanline)) {
        goto cleanup;
      }
      for (uint64_t stored_x_cursor = stored_min_x;
           stored_x_cursor <= stored_max_x; stored_x_cursor++) {
        uint32_t stored_x = (uint32_t)stored_x_cursor;
        uint32_t display_x = 0;
        uint32_t display_y = 0;
        uint64_t source_offset = 0;
        uint64_t output_offset = 0;
        stored_to_oriented(stored_x, stored_y, source_info.width,
                           source_info.height, source_info.orientation,
                           &display_x, &display_y);
        if (display_x < x || display_x >= x + width || display_y < y ||
            display_y >= y + height) {
          continue;
        }
        source_offset = (uint64_t)stored_x * bytes_per_pixel;
        output_offset =
            ((uint64_t)(display_y - y) * width + (display_x - x)) *
            bytes_per_pixel;
        memcpy(output_pixels + output_offset,
               source_scanline + source_offset, (size_t)bytes_per_pixel);
        copied_pixels++;
      }
    }

    if (copied_pixels != (uint64_t)width * height) {
      set_error("The oriented frame pixel count is invalid.");
      goto cleanup;
    }
    for (uint32_t output_y = 0; output_y < height; output_y++) {
      if (TIFFWriteScanline(
              output, output_pixels + (uint64_t)output_y * output_scanline_bytes,
              output_y, 0) < 0) {
        if (!last_error[0]) {
          set_errorf("Could not write output TIFF row %u.", output_y);
        }
        goto cleanup;
      }
    }
  }

  if (!TIFFFlush(output)) {
    if (!last_error[0]) {
      set_error("Could not flush the output TIFF.");
    }
    goto cleanup;
  }
  success = 1;

cleanup:
  free(output_scanline);
  free(output_pixels);
  TIFFClose(output);
  if (!success) {
    remove(output_path);
  }
  return success;

#undef SET_REQUIRED_FIELD
}
