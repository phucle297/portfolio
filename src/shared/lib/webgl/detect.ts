const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;

type GL = WebGLRenderingContext | WebGL2RenderingContext;

/** True when the context is backed by a software rasteriser. */
export function isSoftwareRenderer(gl: GL): boolean {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(
    info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  );
  return SOFTWARE_RENDERER.test(renderer);
}

/**
 * Probe a canvas for a hardware-accelerated WebGL context.
 *
 * Software rasterisers (SwiftShader, llvmpipe, Microsoft Basic Render) turn a continuous render
 * loop into main-thread jank and battery drain, so on those the CSS poster is kept instead.
 * `failIfMajorPerformanceCaveat` catches most of them; the unmasked renderer string catches the
 * rest (e.g. Chrome's ANGLE-on-SwiftShader path, which does not set the caveat flag).
 */
export function probeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): boolean {
  try {
    const attrs: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
    const gl: GL | null = canvas.getContext("webgl2", attrs) ?? canvas.getContext("webgl", attrs);
    if (!gl) return false;
    const hardware = !isSoftwareRenderer(gl);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return hardware;
  } catch {
    return false;
  }
}
