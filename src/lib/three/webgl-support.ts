const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;

/**
 * True when a hardware-accelerated WebGL context is available.
 *
 * Software rasterisers (SwiftShader, llvmpipe, Microsoft Basic Render) turn a continuous render
 * loop into main-thread jank and battery drain, so on those the CSS poster is kept instead.
 * `failIfMajorPerformanceCaveat` catches most of them; the unmasked renderer string catches the
 * rest (e.g. Chrome's ANGLE-on-SwiftShader path, which does not set the caveat flag).
 */
export function hasHardwareWebGL(): boolean {
  try {
    const probe = document.createElement("canvas");
    const attrs: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
    const gl = probe.getContext("webgl2", attrs) ?? probe.getContext("webgl", attrs);
    if (!gl) return false;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return !SOFTWARE_RENDERER.test(renderer);
  } catch {
    return false;
  }
}
