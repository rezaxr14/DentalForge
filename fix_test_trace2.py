with open(r'C:\Users\<owner>\Code\DentalForge\e2e\agent-behaviour.spec.ts', 'r') as f:
    content = f.read()

old = '''test("trace picker filters and switches traces", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should show filter chips
    await expect(page.getByRole("button", { name: /All/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /With tools/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /No tools/i })).toBeVisible();
  });'''

new = '''test("trace picker filters and switches traces", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should show filter chips (in the trace picker sidebar)
    await expect(page.getByRole("button", { name: /All/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /With tools/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /No tools/i }).first()).toBeVisible();
  });'''

if old in content:
    content = content.replace(old, new)
    with open(r'C:\Users\<owner>\Code\DentalForge\e2e\agent-behaviour.spec.ts', 'w') as f:
        f.write(content)
    print("Done")
else:
    print("Pattern not found")