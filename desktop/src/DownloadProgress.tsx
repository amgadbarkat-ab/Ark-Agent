/** 5,154,941,280 as "5.2 GB": the unit a download is quoted in everywhere in the window. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length);
  return `${(bytes / 1000 ** power).toFixed(1)} ${units[power - 1]}`;
}

/**
 * How long is left, in words a person would say.
 *
 * Nothing at all until there is something honest to say: a rate measured over the first few seconds of a
 * download is noise, and "about 9 hours left" that becomes "2 minutes" a moment later teaches people to
 * ignore the line.
 */
export function timeLeftText(
  remainingBytes: number,
  bytesPerSecond: number,
  measuredSeconds: number,
): string | null {
  if (measuredSeconds < 5 || bytesPerSecond <= 0 || remainingBytes <= 0) {
    return null;
  }
  const seconds = remainingBytes / bytesPerSecond;
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `about ${hours} h left`
    : `about ${hours} h ${rest} min left`;
}

/** The bar and the words under a step that is fetching something of known size. */
export function DownloadBar({
  downloaded,
  total,
  measured,
}: {
  downloaded: number;
  total: number;
  /** The first byte count seen and when, so a rate can be measured from the start of this download. */
  measured: { at: number; bytes: number } | null;
}) {
  const percent = Math.min(100, Math.floor((100 * downloaded) / total));
  const seconds = measured ? (Date.now() - measured.at) / 1000 : 0;
  const rate =
    measured && seconds > 0 ? (downloaded - measured.bytes) / seconds : 0;
  const left = timeLeftText(total - downloaded, rate, seconds);
  return (
    <span className="download-line">
      <progress
        className="download-progress"
        max={100}
        value={percent}
        aria-label="Download progress"
      />
      <span className="download-words">
        {formatBytes(downloaded)} of {formatBytes(total)} · {percent}%
        {left ? ` · ${left}` : ""}
      </span>
    </span>
  );
}
