/**
 * M9 editor: history (undo/redo, one step per drag), FDI quick entry, Alt+digit pathology, mirror, Tab cycling,
 * odontogram conflicts and the accessible table view, driven with a real mouse and keyboard.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { startApp, DEAD_DB, SECRETS, type RunningApp } from "./support/app";
import { watchPage } from "./support/page-watch";

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

let app: RunningApp;
test.beforeAll(async () => {
  app = await startApp({ ...SECRETS, DATABASE_URL: DEAD_DB, WORKER_MODE: "off" }); // fixture-backed, no database
});
test.afterAll(async () => app.stop());

const region = (page: Page) => page.getByRole("group", { name: "Radiograph annotation area" });
const rows = (page: Page) => page.getByRole("table").getByRole("row").filter({ has: page.getByRole("button", { name: /^Select box/ }) });
const geometry = async (page: Page, n: number) => (await rows(page).nth(n - 1).getByRole("cell").nth(4).innerText()).split(",").map((v) => Number(v.trim()));

async function open(page: Page) {
  await page.goto(`${app.base}/labels/1`);
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('img[alt^="Radiograph"]');
    return !!img && img.complete && img.naturalWidth > 0;
  });
}

/** Draw with the mouse; coordinates are fractions of the image area. */
async function draw(page: Page, x0: number, y0: number, x1: number, y1: number) {
  const b = (await region(page).boundingBox())!;
  await page.mouse.move(b.x + b.width * x0, b.y + b.height * y0);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * ((x0 + x1) / 2), b.y + b.height * ((y0 + y1) / 2), { steps: 4 });
  await page.mouse.move(b.x + b.width * x1, b.y + b.height * y1, { steps: 4 });
  await page.mouse.up();
}

test("draw, undo and redo", async ({ page }) => {
  const watch = watchPage(page, app.base);
  await open(page);
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Redo" })).toBeEnabled();
  await page.keyboard.press("Control+Shift+Z");
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("Control+Z");
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press("Control+Y");
  await expect(rows(page)).toHaveCount(1);
  expect(watch.problems()).toEqual([]);
});

test("moving a box is ONE undo step", async ({ page }) => {
  await open(page);
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  const drawn = await geometry(page, 1);
  const box = (await page.locator("[data-box-id]").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 30, { steps: 12 });
  await page.mouse.up();
  const moved = await geometry(page, 1);
  expect(moved[0]).toBeGreaterThan(drawn[0]!);
  await page.keyboard.press("Control+Z"); // one press undoes the whole drag, not one mouse-move
  expect(await geometry(page, 1)).toEqual(drawn);
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("Control+Shift+Z");
  expect(await geometry(page, 1)).toEqual(moved);
});

test("two digits set the tooth; Alt+digit sets the pathology; other digits do nothing", async ({ page }) => {
  await open(page);
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  const q = page.getByLabel("Quadrant for box 1");
  const p = page.getByLabel("Position for box 1");
  await expect(q).toHaveValue("3");
  await page.keyboard.press("4");
  await expect(q).toHaveValue("3"); // quadrant alone changes nothing yet
  await page.keyboard.press("6");
  await expect(q).toHaveValue("4");
  await expect(p).toHaveValue("6");
  await page.keyboard.press("9"); // not a quadrant
  await page.keyboard.press("5");
  await expect(q).toHaveValue("4");
  await page.keyboard.press("1");
  await page.keyboard.press("8");
  await expect(q).toHaveValue("1");
  await expect(p).toHaveValue("8");
  await page.keyboard.press("Alt+Digit3");
  await expect(page.getByLabel("Pathology for box 1")).toHaveValue("Periapical Lesion");
  await page.keyboard.press("Control+Z"); // each label edit is its own step
  await expect(page.getByLabel("Pathology for box 1")).toHaveValue("Caries");
});

test("mirror copies to the opposite tooth, reflected across the midline, and flags a conflict", async ({ page }) => {
  await open(page);
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  await page.keyboard.press("m");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByLabel("Quadrant for box 2")).toHaveValue("4"); // default tooth 36 mirrors to 46
  await expect(page.getByLabel("Position for box 2")).toHaveValue("6");
  const [x1, , w1] = await geometry(page, 1);
  const [x2, , w2] = await geometry(page, 2);
  expect(w2).toBe(w1);
  const width = 2744; // fixture image 1 is 2744 px wide
  expect(Math.abs(x1! + w1! + x2! - width)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("status").filter({ hasText: "2/32 teeth have a box" })).toBeVisible();

  await page.keyboard.press("m"); // mirror 46 again: 36 already has a box
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("status").filter({ hasText: "more than one box on 36" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tooth 36: 2 boxes, conflict" })).toBeVisible();
  // Clicking a conflicted tooth walks its boxes (here: box 1 and box 3 both sit on 36).
  const tooth36 = page.getByRole("button", { name: "Tooth 36: 2 boxes, conflict" });
  await tooth36.click();
  const current = async () => (await rows(page).evaluateAll((r) => r.map((x) => x.getAttribute("aria-current") === "true"))).indexOf(true) + 1;
  const first = await current();
  await tooth36.click();
  const second = await current();
  expect([first, second].sort()).toEqual([1, 3]);
  await page.keyboard.press("Control+Z");
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole("status").filter({ hasText: "more than one box" })).toHaveCount(0);
});

test("Tab walks the boxes and then leaves the area (no keyboard trap)", async ({ page }) => {
  await open(page);
  await draw(page, 0.15, 0.3, 0.25, 0.5);
  await draw(page, 0.6, 0.3, 0.7, 0.5);
  await page.keyboard.press("Escape");
  await expect(rows(page).first()).not.toHaveAttribute("aria-current", "true");
  await region(page).focus();
  await page.keyboard.press("Tab");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-current", "true");
  await expect(region(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Shift+Tab");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab"); // past the last box: focus moves on
  await expect(region(page)).not.toBeFocused();
});

test("the table edits the same history as the canvas, and the odontogram follows", async ({ page }) => {
  await open(page);
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  await page.getByLabel("Quadrant for box 1").selectOption("2");
  await page.getByLabel("Position for box 1").selectOption("3");
  await page.getByLabel("Pathology for box 1").selectOption("Impacted");
  await expect(page.getByRole("button", { name: "Tooth 23: 1 box" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click(); // pathology
  await page.getByRole("button", { name: "Undo" }).click(); // position
  await expect(page.getByLabel("Position for box 1")).toHaveValue("6");
  await expect(page.getByRole("button", { name: "Tooth 26: 1 box" })).toBeVisible();
  await page.getByRole("button", { name: "Delete box 1" }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByText("No boxes yet")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(rows(page)).toHaveCount(1);
});

/** WCAG contrast ratio of two sRGB colours given as [r, g, b] bytes. */
function contrast(a: number[], b: number[]): number {
  const lum = ([r, g, bl]: number[]) => {
    const [R, G, B] = [r, g, bl].map((v) => {
      const x = (v ?? 0) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Switches the theme in place (a reload would drop the unsaved boxes these tests are about) and waits until the colour
 * transitions it starts (`transition-colors`, e.g. the active nav link) have finished. axe and the contrast probes read
 * computed colours, and while a transition runs those are blends of the two themes: an axe run that lands inside the
 * 150 ms window reports `dark: color-contrast .bg-accent` on a correct page (reproduced by freezing that transition at 50%).
 */
async function switchTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.style.colorScheme = t;
  }, theme);
  await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) {
      const running = document.getAnimations().filter((a) => a instanceof CSSTransition);
      if (!running.length) return;
      await Promise.allSettled(running.map((a) => a.finished)); // a cancelled transition rejects: it is over either way
    }
  });
}

test("the chosen quadrant is visibly different from the others, in both themes (non-text contrast 3:1)", async ({ page }) => {
  await open(page);
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  for (const theme of ["light", "dark"] as const) {
    await switchTheme(page, theme);
    // Computed colours come back as lab()/oklch() in Tailwind v4; a 1x1 canvas turns any CSS colour into sRGB bytes.
    const bg = (n: string) =>
      page.getByRole("button", { name: n, exact: true }).first().evaluate((el) => {
        const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")!;
        ctx.fillStyle = getComputedStyle(el).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      });
    const chosen = await bg("3"); // new boxes start on quadrant 3
    const other = await bg("1");
    expect(contrast(chosen, other), `${theme}: selected rgb(${chosen}) vs unselected rgb(${other})`).toBeGreaterThanOrEqual(3);
  }
});

test("no WCAG A/AA violations with boxes, a conflict and the table, in both themes", async ({ page }) => {
  await open(page);
  await draw(page, 0.2, 0.3, 0.3, 0.5);
  await page.keyboard.press("m");
  await page.keyboard.press("m");
  await expect(page.getByRole("status").filter({ hasText: "more than one box" })).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    // Switch in place: a reload would drop the unsaved boxes this test is about.
    await switchTheme(page, theme);
    await expect(rows(page)).toHaveCount(3);
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations.map((v) => `${theme}: ${v.id} ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);
  }
});
