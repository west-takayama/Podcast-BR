const scores = { interest: 24, insight: 22, hook: 16, empathy: 13, completeness: 13 };

async function selectEpisode(page) {
  const select = page.getByRole("button", { name: "この回を動画化に選抜する", exact: true });
  const selected = page.getByText("動画化に選抜済み", { exact: true });
  await select.or(selected).waitFor();
  if (await select.isVisible()) await select.click();
  await selected.waitFor();
  const number = page.getByRole("textbox", { name: "ショートに表示する回番号" });
  if (await number.inputValue()) return;
  await page.getByRole("textbox", { name: "ショートに紐づく本編タイトル" }).fill("合成回の本編");
  await number.fill("42");
  await page.getByRole("button", { name: "ショート用の本編情報を保存" }).click();
  await page.getByRole("button", { name: /推奨ショート動画をまとめて生成/ }).waitFor();
}
module.exports = { selectEpisode, scores };
