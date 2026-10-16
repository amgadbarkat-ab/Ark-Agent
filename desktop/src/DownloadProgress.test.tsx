import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { DownloadBar, formatBytes, timeLeftText } from "./DownloadProgress";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("sizes are quoted in decimal units", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2_400_000)).toBe("2.4 MB");
  expect(formatBytes(5_154_941_280)).toBe("5.2 GB");
});

test("no time is promised until there is something honest to say", () => {
  // Too early to know a speed.
  expect(timeLeftText(5_000_000_000, 1_000_000, 2)).toBeNull();
  // No progress yet, or nothing left.
  expect(timeLeftText(5_000_000_000, 0, 30)).toBeNull();
  expect(timeLeftText(0, 1_000_000, 30)).toBeNull();
});

test("time left is said the way a person would say it", () => {
  expect(timeLeftText(30_000_000, 1_000_000, 10)).toBe(
    "less than a minute left",
  );
  expect(timeLeftText(300_000_000, 1_000_000, 10)).toBe("about 5 min left");
  // 150 s rounds up, not down: promising less than it takes is the worse mistake.
  expect(timeLeftText(150_000_000, 1_000_000, 10)).toBe("about 3 min left");
  expect(timeLeftText(3_600_000_000, 1_000_000, 10)).toBe("about 1 h left");
  expect(timeLeftText(5_400_000_000, 1_000_000, 10)).toBe(
    "about 1 h 30 min left",
  );
});

test("the bar shows how much of how much, the percent, and the time left once measured", () => {
  const view = render(
    <DownloadBar
      downloaded={1_300_000_000}
      total={5_200_000_000}
      // First seen 20 s ago at 100 MB: 1.2 GB in 20 s is 60 MB/s, so 3.9 GB is 65 s from done.
      measured={{ at: Date.now() - 20_000, bytes: 100_000_000 }}
    />,
  );
  expect(
    (view.getByLabelText("Download progress") as HTMLProgressElement).value,
  ).toBe(25);
  expect(view.getByText(/1\.3 GB of 5\.2 GB · 25%/)).toBeTruthy();
  expect(view.getByText(/about 2 min left/)).toBeTruthy();
});

test("with nothing measured yet the bar still shows the amount and no time", () => {
  const view = render(
    <DownloadBar downloaded={0} total={5_200_000_000} measured={null} />,
  );
  expect(view.getByText(/0 B of 5\.2 GB · 0%/)).toBeTruthy();
  expect(view.queryByText(/left/)).toBeNull();
});
