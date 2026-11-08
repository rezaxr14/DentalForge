with open(r'C:\Users\rezax\home\Code\DentalForge\e2e\agent-behaviour.spec.ts', 'r') as f:
    lines = f.readlines()

# Find the test function and replace the button checks
new_lines = []
in_test = False
for i, line in enumerate(lines):
    if 'test("loads the default replay' in line:
        in_test = True
    if in_test and 'await expect(page.getByRole("button", { name: /▶ (Play|Replay)/i })).toBeVisible();' in line:
        line = '    await expect(page.getByRole("button", { name: /⏮ Start/i })).toBeVisible();\n'
    elif in_test and 'await expect(page.getByRole("button", { name: /Previous|Step back/i })).toBeVisible();' in line:
        line = '    await expect(page.getByRole("button", { name: /← Prev/i })).toBeVisible();\n'
    elif in_test and 'await expect(page.getByRole("button", { name: /Next|Step forward/i })).toBeVisible();' in line:
        line = '    await expect(page.getByRole("button", { name: /Next →/i })).toBeVisible();\n'
    elif in_test and '// Initially shows Play button (not playing), Previous, Next, End' in line:
        line = '    // Should have replay controls: Start, Prev, Play, Next, End\n'
    new_lines.append(line)

with open(r'C:\Users\rezax\home\Code\DentalForge\e2e\agent-behaviour.spec.ts', 'w') as f:
    f.writelines(new_lines)
print("Done")