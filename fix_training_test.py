with open(r'C:\Users\rezax\home\Code\DentalForge\e2e\training-behaviour.spec.ts', 'r') as f:
    content = f.read()

old = '''test.describe("/training — experiment matrix", () => {
  test("shows real zero-shot numbers, placeholders for SFT/GRPO", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Should show matrix with zero-shot row having real numbers
    await expect(page.locator("text=zero-shot")).toBeVisible();

    // SFT and GRPO rows should show "Not run yet"
    await expect(page.locator("text=SFT").locator("..").locator("text=Not run yet")).toBeVisible();
    await expect(page.locator("text=GRPO").locator("..").locator("text=Not run yet")).toBeVisible();
  });
});'''

new = '''test.describe("/training — experiment matrix", () => {
  test("shows real zero-shot numbers, placeholders for SFT/GRPO", async ({ page }) => {
    await page.goto(`${app.base}/training`);
    await page.waitForLoadState("networkidle");

    // Should show matrix with zero-shot row having real numbers
    await expect(page.locator("table").locator("text=Base (zero-shot)")).toBeVisible();

    // SFT and GRPO rows should show "Not run yet"
    await expect(page.locator("text=SFT").locator("..").locator("text=Not run yet")).toBeVisible();
    await expect(page.locator("text=GRPO").locator("..").locator("text=Not run yet")).toBeVisible();
  });
});'''

if old in content:
    content = content.replace(old, new)
    with open(r'C:\Users\rezax\home\Code\DentalForge\e2e\training-behaviour.spec.ts', 'w') as f:
        f.write(content)
    print("Done")
else:
    print("Pattern not found")