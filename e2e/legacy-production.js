async function openLegacy(page) {
  if (await page.locator(".legacy-production").isVisible()) return;
  const open = page.getByRole("button", { name: "従来の制作を開く" });
  if (!(await open.isVisible())) {
    await page.getByText("従来の制作・中断した回", { exact: true }).click();
  }
  await open.click();
}
module.exports = { openLegacy };
