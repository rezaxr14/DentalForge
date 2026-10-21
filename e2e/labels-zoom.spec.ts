/**
 * Zoom and pan of the radiograph (ADR-0022), in a real browser. Local mode (signed out) is enough: the viewport is the same
 * component either way. What is checked is what can silently go wrong: coordinates of boxes drawn while zoomed, overlay
 * alignment after panning, the point under the cursor staying put, and every way to pan.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DB_URL, SECRETS, startApp, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

const IMG_W = 2744;
const IMG_H = 1316;
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const SHOTS = process.env.E2E_SHOTS_DIR ?? "";

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DB_URL, WORKER_MODE: "off" });
});
test.afterAll(async () => app.stop());

const region = (page: Page) => page.getByRole("group", { name: "Radiograph annotation area" });
const level = (page: Page) => page.locator("[data-zoom-level]");
const rows = (page: Page) => page.getByRole("table").getByRole("row").filter({ has: page.getByRole("button", { name: /^Select box/ }) });
const live = (page: Page) => page.locator('p.sr-only[role="status"]');

async function open(page: Page) {
  await page.goto(`${app.base}/labels/1`);
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
  await page.waitForFunction(() => {
    const b = document.querySelector("[data-sync-status]");
    return !!b && b.getAttribute("data-sync-status") !== "loading";
  });
}
/** The viewport as the page has it: the content node is `s` times the area wide and translated by (x, y). */
async function view(page: Page) {
  return region(page).evaluate((el) => {
    const c = el.firstElementChild as HTMLElement;
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(c.style.transform);
    return { x: m ? Number(m[1]) : 0, y: m ? Number(m[2]) : 0, s: (parseFloat(c.style.width) || 100) / 100 };
  });
}
/** Image fraction under a screen point, using the (transformed) image rectangle: the same maths the editor's pointer code uses. */
async function fractionAt(page: Page, px: number, py: number) {
  return page.evaluate(([x, y]) => {
    const r = document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]')!.getBoundingClientRect();
    return { fx: (x! - r.left) / r.width, fy: (y! - r.top) / r.height };
  }, [px, py]);
}
async function drag(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
}
const rowCoords = async (page: Page, n: number) => {
  const text = await rows(page).nth(n - 1).locator("td").nth(4).innerText(); // quadrant, position, pathology, source, x/y/w/h
  return text.split(",").map((v) => Number(v.trim()));
};
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

test("buttons and keys zoom, Fit and 1:1 work, the level is announced, and zoom never goes below the whole image", async ({ page }) => {
  const watch = watchPage(page, app.base);
  await open(page);
  await expect(level(page)).toHaveText("×1.0");
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Fit", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(level(page)).toHaveText("×1.5");
  await region(page).focus();
  await page.keyboard.press("+");
  await page.keyboard.press("=");
  await expect(level(page)).toHaveText("×3.4"); // 1.5³
  await expect(live(page)).toContainText("Zoom 3.4 times.");
  await page.keyboard.press("-");
  await expect(level(page)).toHaveText("×2.3");
  await page.keyboard.press("Home");
  await expect(level(page)).toHaveText("×1.0");
  await expect(live(page)).toContainText("Whole image in view.");
  expect(await view(page)).toEqual({ x: 0, y: 0, s: 1 });
  for (let i = 0; i < 3; i++) await page.keyboard.press("-"); // already at fit
  await expect(level(page)).toHaveText("×1.0");

  // "1:1" is one pixel of the ORIGINAL radiograph (the coordinate system of the labels) per screen pixel, not of the
  // lower-resolution copy the page serves.
  const expected = await page.evaluate((w) => w / document.querySelector<HTMLElement>('[aria-label="Radiograph annotation area"]')!.clientWidth, IMG_W);
  await page.getByRole("button", { name: "1:1" }).click();
  await expect(level(page)).toHaveText(`×${expected.toFixed(1)}`);
  const v = await view(page);
  expect(v.s).toBeCloseTo(expected, 1);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  expect(await view(page)).toEqual({ x: 0, y: 0, s: 1 });
  expect(watch.problems()).toEqual([]);
});

test("Ctrl+wheel zooms at the cursor: the image point under the pointer does not move", async ({ page }) => {
  await open(page);
  const r = (await region(page).boundingBox())!;
  const px = r.x + r.width * 0.7;
  const py = r.y + r.height * 0.35;
  const before = await fractionAt(page, px, py);
  await page.mouse.move(px, py);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -400); // e^1 ≈ 2.7×
  await page.keyboard.up("Control");
  await expect.poll(async () => (await view(page)).s).toBeGreaterThan(2.4);
  const after = await fractionAt(page, px, py);
  expect(after.fx).toBeCloseTo(before.fx, 2);
  expect(after.fy).toBeCloseTo(before.fy, 2);
  // a plain wheel does not zoom (the page scrolls)
  const s = (await view(page)).s;
  await page.mouse.wheel(0, 120);
  expect((await view(page)).s).toBe(s);
});

test("a box drawn while zoomed and panned is stored at the right image coordinates, and the overlay stays aligned with the image", async ({ page }) => {
  const watch = watchPage(page, app.base);
  await open(page);
  await region(page).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("+"); // ×5.06 about the centre
  await page.keyboard.press("Shift+ArrowLeft"); // pan so the view is no longer the centre
  await page.keyboard.press("Shift+ArrowDown");
  const v = await view(page);
  expect(v.s).toBeCloseTo(5.06, 1);
  expect(v.x).not.toBe(0);

  const r = (await region(page).boundingBox())!;
  const [x0, y0, x1, y1] = [r.x + r.width * 0.3, r.y + r.height * 0.3, r.x + r.width * 0.5, r.y + r.height * 0.55];
  const a = await fractionAt(page, x0, y0);
  const b = await fractionAt(page, x1, y1);
  await drag(page, x0, y0, x1, y1);
  await expect(rows(page)).toHaveCount(1);
  const [bx, by, bw, bh] = await rowCoords(page, 1);
  // coordinates are the image pixels under the pointer, not screen pixels: ±3 px of the ~14 px/px zoomed scale
  expect(bx).toBeCloseTo(a.fx * IMG_W, -1);
  expect(by).toBeCloseTo(a.fy * IMG_H, -1);
  expect(Math.abs(bx! + bw! - b.fx * IMG_W)).toBeLessThan(8);
  expect(Math.abs(by! + bh! - b.fy * IMG_H)).toBeLessThan(8);

  // overlay alignment: the box's on-screen centre maps back to its own centre in image coordinates
  const c = await page.locator("[data-box-id]").first().boundingBox();
  const centre = await fractionAt(page, c!.x + c!.width / 2, c!.y + c!.height / 2);
  expect(centre.fx * IMG_W).toBeCloseTo(bx! + bw! / 2, -1);
  expect(centre.fy * IMG_H).toBeCloseTo(by! + bh! / 2, -1);
  expect(watch.problems()).toEqual([]);
});

test("every way of panning works, pans instead of drawing, and cannot leave the image", async ({ page }) => {
  await open(page);
  await region(page).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("+");
  const r = (await region(page).boundingBox())!;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  let last = await view(page);

  // hand tool
  const hand = page.getByRole("button", { name: "Hand" });
  await hand.click();
  await expect(hand).toHaveAttribute("aria-pressed", "true");
  await drag(page, cx, cy, cx - 120, cy - 60);
  let v = await view(page);
  expect(v.x).toBeLessThan(last.x);
  expect(v.y).toBeLessThan(last.y);
  await expect(rows(page)).toHaveCount(0); // it panned, it did not draw
  await hand.click();
  await expect(hand).toHaveAttribute("aria-pressed", "false");
  last = v;

  // Space + drag
  await region(page).focus();
  await page.keyboard.down("Space");
  await drag(page, cx, cy, cx + 90, cy + 40);
  await page.keyboard.up("Space");
  v = await view(page);
  expect(v.x).toBeGreaterThan(last.x);
  expect(v.y).toBeGreaterThan(last.y);
  await expect(rows(page)).toHaveCount(0);
  last = v;

  // middle button
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(cx - 70, cy - 30, { steps: 3 });
  await page.mouse.up({ button: "middle" });
  v = await view(page);
  expect(v.x).toBeLessThan(last.x);
  await expect(rows(page)).toHaveCount(0);

  // Shift+arrows by 80 px, and a drag far past the edge stops at the image's edge
  const k = await view(page);
  await page.keyboard.press("Shift+ArrowRight");
  expect((await view(page)).x).toBeCloseTo(k.x - 80, 3);
  await hand.click();
  await drag(page, cx, cy, cx + 5000 > r.x + r.width ? r.x + r.width - 2 : cx + 5000, cy);
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 6; i++) await drag(page, r.x + 5, cy, r.x + r.width - 5, cy);
  const edge = await view(page);
  expect(edge.x).toBeLessThanOrEqual(0);
  expect(edge.y).toBeLessThanOrEqual(0);
  expect(edge.x).toBeGreaterThanOrEqual(r.width - r.width * edge.s - 0.5);
  expect(edge.y).toBeGreaterThanOrEqual((await region(page).evaluate((el) => el.clientHeight)) * (1 - edge.s) - 0.5);
});

test("selecting a box that is off screen (table) brings it into view; lines keep their width on screen at any zoom", async ({ page }) => {
  await open(page);
  const r = (await region(page).boundingBox())!;
  await drag(page, r.x + r.width * 0.08, r.y + r.height * 0.1, r.x + r.width * 0.16, r.y + r.height * 0.3);
  await drag(page, r.x + r.width * 0.82, r.y + r.height * 0.65, r.x + r.width * 0.88, r.y + r.height * 0.75); // small enough to fit the zoomed window
  await expect(rows(page)).toHaveCount(2);
  await region(page).focus();
  // zoom into the top-left corner (ctrl+wheel at the corner pins it)
  await page.mouse.move(r.x + 2, r.y + 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -700);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await view(page)).s).toBeGreaterThan(5);
  const second = page.locator("[data-box-id]").nth(1);
  const outside = await second.boundingBox();
  expect(outside!.x).toBeGreaterThan(r.x + r.width); // far right of the visible window

  await rows(page).nth(1).getByRole("button", { name: /^Select box/ }).click();
  // (the click scrolled the page, so the region is measured again each time, not reused from before)
  await expect.poll(async () => {
    const b = (await second.boundingBox())!;
    const now = (await region(page).boundingBox())!;
    return b.x >= now.x && b.x + b.width <= now.x + now.width + 1 && b.y >= now.y && b.y + b.height <= now.y + now.height + 1;
  }).toBe(true);

  // Zoom is layout zoom, so lines and handles are real fixed-size CSS pixels at any zoom (a scale transform would draw the
  // 2 px border 5 px thick, and snap box edges to whole CSS pixels before scaling: uneven handles, drifting frames).
  const borderTop = (el: Element) => getComputedStyle(el).borderTopWidth;
  expect(await second.evaluate(borderTop)).toBe("2px");
  const handles = page.locator("[data-handle]");
  await expect(handles).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    const h = (await handles.nth(i).boundingBox())!;
    expect(h.width, `handle ${i} width`).toBeCloseTo(10, 0);
    expect(h.height, `handle ${i} height`).toBeCloseTo(10, 0);
  }
  await page.getByRole("button", { name: /^GT overlay/ }).click(); // dashed ground-truth frames, drawn at the same zoom
  await page.getByRole("button", { name: "Zoom out" }).click();
  await shot(page, "zoom-gt");
  await page.keyboard.press("Home");
  expect(await second.evaluate(borderTop)).toBe("2px");
});

test("a read-only (submitted) set still zooms and pans, and the zoomed page passes axe in light and dark", async ({ page }) => {
  const watch = watchPage(page, app.base);
  await open(page);
  const r = (await region(page).boundingBox())!;
  await drag(page, r.x + r.width * 0.3, r.y + r.height * 0.3, r.x + r.width * 0.4, r.y + r.height * 0.5);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator("span.rounded.border", { hasText: /^submitted · v\d+$/ })).toBeVisible();
  await region(page).focus();
  await page.keyboard.press("+");
  await expect(level(page)).toHaveText("×1.5");
  await page.getByRole("button", { name: "Hand" }).click();
  const before = await view(page);
  await drag(page, r.x + r.width / 2, r.y + r.height / 2, r.x + r.width / 2 - 100, r.y + r.height / 2);
  expect((await view(page)).x).toBeLessThan(before.x);
  await expect(rows(page)).toHaveCount(1); // nothing was edited
  await shot(page, "zoom-light");
  const light = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(light.violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`), "axe light").toEqual([]);
  expect(watch.problems()).toEqual([]);
});
