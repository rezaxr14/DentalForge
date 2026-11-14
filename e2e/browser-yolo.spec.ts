/**
 * Browser YOLO, end to end (ADR-0027).
 *
 * The editor offers "Run in my browser": a Web Worker downloads the committed
 * 49.5 MiB DENTEX-only ONNX graph, verifies its SHA-256, decodes the radiograph
 * with OffscreenCanvas and runs onnxruntime-web's single-threaded WASM backend.
 * This spec proves the whole path in a real browser - including that the CSP
 * allows WebAssembly compilation, that the worker is same-origin, and that the
 * boxes land in the editor with `browser_approx` provenance.
 */
import { expect, test } from "@playwright/test";
import { DEAD_DB, SECRETS, startApp, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

let app: RunningApp;

test.beforeAll(async () => {
  // No database and no worker on purpose: the browser tier must not depend on either.
  app = await startApp({ ...SECRETS, DATABASE_URL: DEAD_DB, WORKER_MODE: "off" });
});
test.afterAll(async () => app.stop());

test("the editor pre-labels image 1 in the browser, with no worker and no database", async ({ page }) => {
  test.setTimeout(240_000);
  const watch = watchPage(page, app.base);

  await page.goto(`${app.base}/labels/1`);
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });

  // The ladder must offer the browser rung here, and say how big the download is.
  const button = page.locator('[data-suggest="browser"]');
  await expect(button).toBeVisible();
  await expect(button).toHaveText(/Run in my browser \(about 49 MB\)/);
  await expect(page.locator("[data-capability-reason]")).toContainText("Runs in this browser");

  await button.click();

  // First run downloads and compiles the graph; give WASM on a shared CI box room.
  await expect(page.locator("[data-box-id]").first()).toBeVisible({ timeout: 200_000 });
  const boxes = await page.locator("[data-box-id]").count();
  expect(boxes).toBeGreaterThan(10);

  const message = await page.getByText(/provenance: browser_approx/).innerText();
  expect(message).toMatch(/Ran DENTEX-trained YOLOv8m \(fold 0\), ONNX fp16, 640px in your browser/);
  // The inference itself must be seconds, not minutes: a hang here means the
  // WASM backend fell back to something pathological.
  const ms = Number(/in (\d+) ms/.exec(message)?.[1] ?? Number.NaN);
  expect(ms).toBeGreaterThan(0);
  expect(ms).toBeLessThan(60_000);

  // Boxes authored by the model are `model` source and carry the ONNX model id.
  const firstRow = page.getByRole("table").getByRole("row").filter({ has: page.getByRole("button", { name: /^Select box/ }) }).first();
  await expect(firstRow).toContainText("model");

  expect(watch.problems()).toEqual([]);
});

test("a second run reuses the cached graph instead of downloading it again", async ({ page }) => {
  test.setTimeout(240_000);
  const watch = watchPage(page, app.base);
  await page.goto(`${app.base}/labels/2`);
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });

  let downloads = 0;
  page.on("response", (response) => {
    if (response.url().endsWith("/models/yolo/yolov8m-dentex-fp16-640.onnx")) downloads += 1;
  });

  await page.locator('[data-suggest="browser"]').click();
  await expect(page.locator("[data-box-id]").first()).toBeVisible({ timeout: 200_000 });
  // The worker still asks for the URL, but the answer comes from Cache Storage.
  const fromCache = await page.evaluate(async () => {
    const cache = await caches.open("df.yolo.v1");
    const hit = await cache.match("/models/yolo/yolov8m-dentex-fp16-640.onnx");
    return hit ? (await hit.arrayBuffer()).byteLength : 0;
  });
  expect(fromCache).toBe(51_878_944);
  expect(downloads).toBeLessThanOrEqual(1);
  expect(watch.problems()).toEqual([]);
});
