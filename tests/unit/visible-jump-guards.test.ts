/**
 * PF-62: software-renderer refusal comes first on a GPU run, and a single stall longer than
 * MAX_FRAME_GAP_MS fails as "not enough frames".
 */
import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_GAP_MS,
  MIN_FRAMES,
  firstVisibleJumpFailure,
  isSoftwareRenderer,
  maxFrameGapMs,
  notEnoughFramesMessage,
  type VisibleJumpGuardInput,
} from "../e2e/visible-jump";

const ok: VisibleJumpGuardInput = {
  realGpu: true,
  renderer: "ANGLE (NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)",
  expectedTier: "full",
  actualTier: "full",
  expectedPin: "on",
  actualPin: "on",
  firstPaint: 120,
  framesAfterFirstPaint: 80,
  maxFrameGapMs: 20,
};

describe("isSoftwareRenderer", () => {
  it("matches llvmpipe, SwiftShader, and generic software strings", () => {
    expect(isSoftwareRenderer("ANGLE (Mesa, llvmpipe (LLVM 19.1.7 256 bits), OpenGL 4.5)")).toBe(
      true,
    );
    expect(isSoftwareRenderer("Google SwiftShader")).toBe(true);
    expect(isSoftwareRenderer("ANGLE (SwiftShader)")).toBe(true);
    expect(isSoftwareRenderer("Software Adapter")).toBe(true);
    expect(isSoftwareRenderer(ok.renderer)).toBe(false);
    expect(isSoftwareRenderer(null)).toBe(false);
  });
});

describe("maxFrameGapMs", () => {
  it("returns 0 for fewer than two samples and the largest consecutive delta otherwise", () => {
    expect(maxFrameGapMs([])).toBe(0);
    expect(maxFrameGapMs([100])).toBe(0);
    expect(maxFrameGapMs([0, 16, 33, 50])).toBe(17);
    expect(maxFrameGapMs([0, 16, 1516, 1532])).toBe(1500);
  });
});

describe("firstVisibleJumpFailure", () => {
  it("on a GPU run, fails first with 'no hardware GPU' before the tier check", () => {
    const failure = firstVisibleJumpFailure({
      ...ok,
      renderer: "ANGLE (Mesa, llvmpipe (LLVM 19.1.7 256 bits), OpenGL 4.5)",
      actualTier: "static",
      actualPin: null,
    });
    expect(failure).toMatch(/^no hardware GPU:/);
    expect(failure).toMatch(/llvmpipe/);
    expect(failure).not.toMatch(/data-tier/);
  });

  it("on a GPU run, SwiftShader also fails first with 'no hardware GPU'", () => {
    const failure = firstVisibleJumpFailure({
      ...ok,
      renderer: "Google SwiftShader",
      actualTier: "static",
    });
    expect(failure).toBe("no hardware GPU: WebGL renderer is Google SwiftShader");
  });

  it("on a GPU run with a hardware renderer, a wrong tier is the first failure", () => {
    const failure = firstVisibleJumpFailure({
      ...ok,
      actualTier: "static",
    });
    expect(failure).toBe("data-tier at the end of the window");
  });

  it("a single stall longer than the cap fails as 'not enough frames' even with enough frames", () => {
    const gap = MAX_FRAME_GAP_MS + 1;
    const failure = firstVisibleJumpFailure({
      ...ok,
      realGpu: false,
      framesAfterFirstPaint: 80,
      maxFrameGapMs: gap,
    });
    expect(failure).toBe(notEnoughFramesMessage(80, gap));
    expect(failure).toMatch(/^not enough frames:/);
    expect(failure).toContain(`cap ${MAX_FRAME_GAP_MS} ms`);
  });

  it("a gap equal to the cap still passes the frame budget", () => {
    expect(
      firstVisibleJumpFailure({
        ...ok,
        framesAfterFirstPaint: MIN_FRAMES,
        maxFrameGapMs: MAX_FRAME_GAP_MS,
      }),
    ).toBeNull();
  });

  it("too few frames still fail as 'not enough frames'", () => {
    const failure = firstVisibleJumpFailure({
      ...ok,
      realGpu: false,
      framesAfterFirstPaint: 11,
      maxFrameGapMs: 288,
    });
    expect(failure).toBe(notEnoughFramesMessage(11, 288));
    expect(failure).toMatch(/^not enough frames:/);
  });

  it("a spoofed CI run on llvmpipe with a 534 ms gap (under the cap) passes the gates", () => {
    expect(
      firstVisibleJumpFailure({
        ...ok,
        realGpu: false,
        renderer: "ANGLE (Mesa, llvmpipe (LLVM 19.1.7 256 bits), OpenGL 4.5)",
        maxFrameGapMs: 534,
      }),
    ).toBeNull();
  });

  it("a clean hardware-GPU run passes the gates", () => {
    expect(firstVisibleJumpFailure(ok)).toBeNull();
  });
});
