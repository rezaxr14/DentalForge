with open(r'C:\Users\<owner>\Code\DentalForge\e2e\agent-behaviour.spec.ts', 'r') as f:
    content = f.read()

old = '''test.describe("/agent — replay controls", () => {
  test("loads the default replay and shows turn timeline", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should show the replay header with case name
    await expect(page.getByRole("heading", { name: /DENTEX case/ })).toBeVisible();

    // Should have replay controls: step, play, pause, end
    // Initially shows Play button (not playing), Previous, Next, End
    await expect(page.getByRole("button", { name: /▶ (Play|Replay)/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Previous|Step back/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Next|Step forward/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /End/i })).toBeVisible();

    // Should show turn timeline with at least one turn
    await expect(page.locator("ol[role='region']")).toBeVisible();
  });'''

new = '''test.describe("/agent — replay controls", () => {
  test("loads the default replay and shows turn timeline", async ({ page }) => {
    await page.goto(`${app.base}/agent`);
    await page.waitForLoadState("networkidle");

    // Should show the replay header with case name
    await expect(page.getByRole("heading", { name: /DENTEX case/ })).toBeVisible();

    // Should have replay controls: Start, Prev, Play, Next, End
    await expect(page.getByRole("button", { name: /⏮ Start/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /← Prev/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /▶ Play/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Next →/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /End/i })).toBeVisible();

    // Should show turn timeline with at least one turn
    await expect(page.locator("ol[role='region']")).toBeVisible();
  });'''

if old in content:
    content = content.replace(old, new)
    with open(r'C:\Users\<owner>\Code\DentalForge\e2e\agent-behaviour.spec.ts', 'w') as f:
        f.write(content)
    print("Done")
else:
    print("Pattern not found")