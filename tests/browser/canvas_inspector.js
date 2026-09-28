/**
 * tests/browser/canvas_inspector.js
 * Dual-Layer Canvas Pixel Sampler and Telegraph Rendering Inspector
 *
 * Implements:
 * 1. Layer 1: Visual Pixel Sampling via 2D Canvas getImageData.
 * 2. Layer 2: Context Instrumentation & Telemetry Hooks for precise timing audits.
 */

class CanvasInspector {
  /**
   * Samples a single RGBA pixel at specific screen coordinates on the canvas.
   * @param {object} page - Puppeteer page
   * @param {number} screenX - X coordinate in canvas space
   * @param {number} screenY - Y coordinate in canvas space
   * @param {string} canvasSelector - DOM selector (default #gameCanvas)
   * @returns {Promise<{r: number, g: number, b: number, a: number}>}
   */
  static async getPixel(page, screenX, screenY, canvasSelector = '#gameCanvas') {
    return await page.evaluate(({ sel, x, y }) => {
      const canvas = document.querySelector(sel);
      if (!canvas) throw new Error(`Canvas element '${sel}' not found in DOM`);
      const ctx = canvas.getContext('2d');
      const px = Math.min(Math.max(0, Math.round(x)), canvas.width - 1);
      const py = Math.min(Math.max(0, Math.round(y)), canvas.height - 1);
      const data = ctx.getImageData(px, py, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] };
    }, { sel: canvasSelector, x: screenX, y: screenY });
  }

  /**
   * Samples multiple radial points around a center coordinate to verify circular AoE indicators.
   * @param {object} page
   * @param {number} centerX
   * @param {number} centerY
   * @param {number} radius
   * @param {number} sampleCount
   * @param {string} canvasSelector
   * @returns {Promise<Array<{angle: number, x: number, y: number, r: number, g: number, b: number, a: number}>>}
   */
  static async sampleCircle(page, centerX, centerY, radius, sampleCount = 8, canvasSelector = '#gameCanvas') {
    return await page.evaluate(({ sel, cx, cy, r, count }) => {
      const canvas = document.querySelector(sel);
      if (!canvas) throw new Error(`Canvas '${sel}' not found`);
      const ctx = canvas.getContext('2d');
      const samples = [];

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const px = Math.min(Math.max(0, Math.round(cx + Math.cos(angle) * r)), canvas.width - 1);
        const py = Math.min(Math.max(0, Math.round(cy + Math.sin(angle) * r)), canvas.height - 1);
        const d = ctx.getImageData(px, py, 1, 1).data;
        samples.push({
          angle,
          x: px,
          y: py,
          r: d[0],
          g: d[1],
          b: d[2],
          a: d[3]
        });
      }
      return samples;
    }, { sel: canvasSelector, cx: centerX, cy: centerY, r: radius, count: sampleCount });
  }

  /**
   * Computes the average RGBA color across a rectangular area.
   * @param {object} page
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {string} canvasSelector
   * @returns {Promise<{r: number, g: number, b: number, a: number}>}
   */
  static async sampleAreaAverage(page, x, y, width = 10, height = 10, canvasSelector = '#gameCanvas') {
    return await page.evaluate(({ sel, rx, ry, rw, rh }) => {
      const canvas = document.querySelector(sel);
      if (!canvas) throw new Error(`Canvas '${sel}' not found`);
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(Math.round(rx), Math.round(ry), rw, rh);
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      const totalPixels = img.data.length / 4;

      for (let i = 0; i < img.data.length; i += 4) {
        rSum += img.data[i];
        gSum += img.data[i + 1];
        bSum += img.data[i + 2];
        aSum += img.data[i + 3];
      }

      return {
        r: Math.round(rSum / totalPixels),
        g: Math.round(gSum / totalPixels),
        b: Math.round(bSum / totalPixels),
        a: Math.round(aSum / totalPixels)
      };
    }, { sel: canvasSelector, rx: x, ry: y, rw: width, rh: height });
  }

  /**
   * Verifies if a sampled pixel exhibits the characteristic red telegraph coloration.
   * Red channel elevated above green and blue channels.
   * @param {{r: number, g: number, b: number, a: number}} pixel
   * @returns {boolean}
   */
  static isRedTelegraphActive(pixel) {
    if (!pixel) return false;
    // Red must be dominant over green and blue, and green must NOT be high yellow/orange (rejection of Warrior #ffaa00)
    const rDominant = pixel.r >= 130 && pixel.r > (pixel.g * 1.5) && pixel.r > (pixel.b * 1.5);
    const notOrangeOrYellow = pixel.g < 140; // Rejects #ffaa00 where G=170
    const notHealthBar = !(pixel.r > 200 && pixel.g < 60 && pixel.b < 60 && pixel.a === 255); // Health bar is solid opaque red
    const notEliteAura = !(pixel.r < 220 && pixel.g >= 90 && pixel.b >= 70);
    const notWarmodePlayer = !(pixel.r > 220 && pixel.g >= 100 && pixel.b >= 100);
    return rDominant && notOrangeOrYellow && notHealthBar && notEliteAura && notWarmodePlayer && pixel.a > 0;
  }

  /**
   * Injects Canvas context telemetry hooks to spy on arc/fill/stroke draw calls for telegraphs.
   * @param {object} page
   * @returns {Promise<void>}
   */
  static async installRenderSpy(page) {
    await page.evaluate(() => {
      if (window.__CANVAS_SPY_INSTALLED__) return;
      window.__CANVAS_SPY_INSTALLED__ = true;

      const origArc = CanvasRenderingContext2D.prototype.arc;
      const origFill = CanvasRenderingContext2D.prototype.fill;
      const origStroke = CanvasRenderingContext2D.prototype.stroke;

      CanvasRenderingContext2D.prototype.arc = function(x, y, radius, startAngle, endAngle, counterclockwise) {
        const style = String(this.fillStyle || this.strokeStyle || '');
        if ((style.includes('255, 0, 0') || style.includes('#ff0000') || style.includes('red') || style.includes('rgba(255')) && radius >= 40) {
          if (window.__MMO_TEST_TELEMETRY__) {
            window.__MMO_TEST_TELEMETRY__.telegraphRenders.push({
              time: Date.now(),
              x,
              y,
              radius,
              style
            });
          }
        }
        return origArc.apply(this, arguments);
      };
    });
  }

  /**
   * Retrieves telegraph telemetry history from the page.
   * @param {object} page
   * @returns {Promise<Array<object>>}
   */
  static async getTelegraphTelemetry(page) {
    return await page.evaluate(() => {
      return (window.__MMO_TEST_TELEMETRY__ && window.__MMO_TEST_TELEMETRY__.telegraphRenders)
        ? window.__MMO_TEST_TELEMETRY__.telegraphRenders
        : [];
    });
  }
}

module.exports = CanvasInspector;
