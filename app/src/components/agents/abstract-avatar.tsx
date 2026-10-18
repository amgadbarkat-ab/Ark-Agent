/** ArkAgent's own icon: what every coworker shows until its owner chooses a picture. */
export const DEFAULT_BOT_ICON = "/brand/arkagent-icon.jpg";

export function AbstractAvatar({
  name,
  image,
  size = 40,
}: {
  name: string;
  /** The picture its owner chose, or null for the default icon. */
  image?: string | null;
  size?: number;
}) {
  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0 overflow-hidden rounded-full bg-muted"
      style={{ height: size, width: size }}
    >
      {/* The picture carries no text of its own; hidden so the coworker is announced once, by name. */}
      <img
        alt=""
        aria-hidden="true"
        className="size-full object-cover"
        height={size}
        src={image ?? DEFAULT_BOT_ICON}
        width={size}
      />
    </span>
  );
}
