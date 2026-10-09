import { describe, expect, test } from "bun:test";
import {
  buildShapes,
  createParticleMark,
  modelView,
  mountParticleMark,
  multiply,
  perspective,
} from "./particle-mark";

describe("the shapes", () => {
  const first = buildShapes(2000);

  test("are the same every time, so every visit draws the same picture", () => {
    const again = buildShapes(2000);
    for (let shape = 0; shape < 3; shape++) {
      expect(again.shapes[shape]).toEqual(first.shapes[shape]);
    }
    expect(again.random).toEqual(first.random);
  });

  test("give every point three numbers in each shape, and three of its own", () => {
    for (const shape of first.shapes) expect(shape.length).toBe(2000 * 3);
    expect(first.random.length).toBe(2000 * 3);
    for (const value of first.random) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test("the globe is a sphere of about the website's radius", () => {
    const globe = first.shapes[1];
    for (let i = 0; i < 2000; i++) {
      const radius = Math.hypot(
        globe[i * 3],
        globe[i * 3 + 1],
        globe[i * 3 + 2],
      );
      expect(radius).toBeGreaterThan(3.2 * 0.98);
      expect(radius).toBeLessThan(3.2 * 1.02);
    }
  });

  test("the mark is a frame with three bars rising to the right", () => {
    const mark = first.shapes[2];
    // The bars sit between the frame's edges, in x: -1.05..1.05 plus half a bar; the tallest is on the right.
    let tallestOnRight = -Infinity;
    let tallestOnLeft = -Infinity;
    for (let i = Math.floor(2000 * 0.3); i < 2000; i++) {
      const x = mark[i * 3];
      const y = mark[i * 3 + 1];
      expect(Math.abs(x)).toBeLessThan(1.6);
      if (x > 0.6) tallestOnRight = Math.max(tallestOnRight, y);
      if (x < -0.6) tallestOnLeft = Math.max(tallestOnLeft, y);
    }
    expect(tallestOnRight).toBeGreaterThan(tallestOnLeft);
    // The frame's points lie on a square of half-width 3.4.
    for (let i = 0; i < Math.floor(2000 * 0.3); i++) {
      const edge = Math.max(Math.abs(mark[i * 3]), Math.abs(mark[i * 3 + 1]));
      expect(edge).toBeGreaterThan(3.3);
      expect(edge).toBeLessThan(3.5);
    }
  });
});

describe("the camera", () => {
  /** A point in view space, to clip space, and then to the screen's -1..1. */
  function project(matrix: Float32Array, x: number, y: number, z: number) {
    const clip = [0, 1, 2, 3].map(
      (row) =>
        matrix[row] * x +
        matrix[4 + row] * y +
        matrix[8 + row] * z +
        matrix[12 + row],
    );
    return { x: clip[0] / clip[3], y: clip[1] / clip[3] };
  }

  test("looks at the middle of the picture", () => {
    const at = project(multiply(perspective(1.5), modelView(0, 0)), 0, 0, 0);
    expect(at.x).toBeCloseTo(0, 6);
    expect(at.y).toBeCloseTo(0, 6);
  });

  test("shows things above the middle above it, and to the right on the right", () => {
    const projection = multiply(perspective(2), modelView(0, 0));
    const up = project(projection, 0, 2, 0);
    const right = project(projection, 2, 0, 0);
    expect(up.y).toBeGreaterThan(0);
    expect(right.x).toBeGreaterThan(0);
    // A wider picture spreads the same distance over more width, so the same step goes less far across.
    const square = project(multiply(perspective(1), modelView(0, 0)), 2, 0, 0);
    expect(right.x).toBeLessThan(square.x);
  });

  test("turning the points about y brings a point on the right towards the camera", () => {
    const turned = project(
      multiply(perspective(1), modelView(0, Math.PI / 2)),
      2,
      0,
      0,
    );
    // A quarter turn puts what was at x = 2 on the z axis: straight ahead of the camera.
    expect(turned.x).toBeCloseTo(0, 5);
  });
});

describe("where there is no WebGL", () => {
  const noWebGl = {
    getContext: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;

  test("the picture is not made, and says so", () => {
    expect(createParticleMark(noWebGl)).toBeNull();
  });

  test("a container is left as it was, marked off", () => {
    const attributes: Record<string, string> = {};
    const children: unknown[] = [];
    const container = {
      dataset: attributes,
      appendChild: (child: unknown) => children.push(child),
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as HTMLElement;
    const canvas = {
      style: {} as Record<string, string>,
      setAttribute: () => {},
      remove: () => {
        children.length = 0;
      },
      getContext: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const original = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => canvas, hidden: false },
    });
    try {
      const undo = mountParticleMark(container);
      expect(attributes.particles).toBe("off");
      // The canvas it tried is gone again, so the still picture is all there is.
      expect(children.length).toBe(0);
      undo();
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: original,
      });
    }
  });
});
