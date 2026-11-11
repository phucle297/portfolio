/** Off-main-thread hardware WebGL probe (see probeHardwareWebGL). */
import { probeCanvas } from "./webgl-support";

postMessage(probeCanvas(new OffscreenCanvas(1, 1)));
