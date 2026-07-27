export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function fileStem(fileName: string): string {
  const stem = fileName.replace(/\.(tif|tiff)$/i, '');
  return stem || 'framecut';
}

export function outputFileName(
  sourceName: string,
  index: number,
  total: number,
): string {
  const digits = Math.max(2, String(total).length);
  return `${fileStem(sourceName)}_${String(index + 1).padStart(digits, '0')}.tif`;
}

export function outputBatchName(date: Date): string {
  const number = (value: number) => String(value).padStart(2, '0');
  return [
    'framecut',
    `${date.getFullYear()}${number(date.getMonth() + 1)}${number(date.getDate())}`,
    `${number(date.getHours())}${number(date.getMinutes())}${number(date.getSeconds())}`,
  ].join('-');
}

export function batchOutputFileName(
  batchName: string,
  index: number,
  total: number,
): string {
  const digits = Math.max(2, String(total).length);
  return `${batchName}-${String(index + 1).padStart(digits, '0')}.tif`;
}
