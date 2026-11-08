with open(r'C:\Users\rezax\home\Code\DentalForge\e2e\training-behaviour.spec.ts', 'r') as f:
    content = f.read()

# Replace the experiment matrix test
old = '''// Should show matrix with zero-shot row having real numbers
    await expect(page.locator("text=zero-shot")).toBeVisible();

    // SFT and GRPO rows should show "Not run yet"
    await expect(page.locator("text=SFT").locator("..").locator("text=Not run yet")).toBeVisible();
    await expect(page.locator("text=GRPO").locator("..").locator("text=Not run yet")).toBeVisible();'''

new = '''// Should show matrix with zero-shot row having real numbers
    await expect(page.locator("table").locator("text=Base (zero-shot)")).toBeVisible();

    // SFT and GRPO rows should show "Not run yet"
    await expect(page.locator("text=SFT").locator("..").locator("text=Not run yet")).toBeVisible();
    await expect(page.locator("text=GRPO").locator("..").locator("text=Not run yet")).toBeVisible();'''

if old in content:
    content = content.replace(old, new)
    with open(r'C:\Users\rezax\home\Code\DentalForge\e2e\training-behaviour.spec.ts', 'w') as f:
        f.write(content)
    print("Done")
else:
    print("Pattern not found")
    # Find the exact text
    idx = content.find('zero-shot')
    if idx >= 0:
        print(f"Found at {idx}: {content[idx:idx+200]}")