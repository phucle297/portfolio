/** Off-main-thread hardware WebGL probe (see probeHardwareWebGL). */
import { probeCanvas } from "./detect";

postMessage(probeCanvas(new OffscreenCanvas(1, 1)));
