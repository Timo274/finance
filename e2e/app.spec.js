import { expect, test } from "@playwright/test";

test("sets up PIN, creates a plan and adds a wishlist item", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator("#authGate")).toBeVisible();
  await expect(page.locator("#authTitle")).toHaveText("Создайте PIN");
  await page.locator("#pinInput").fill("1234");
  await page.locator("#pinConfirm").fill("1234");
  await page.locator("#authSubmit").click();

  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#topPlanName")).toHaveText(
    "Зарплата не настроена",
  );

  await page.locator("#editPlanBtn").click();
  await page.locator('#planForm input[name="name"]').fill("E2E salary");
  await page.locator('#planForm input[name="payday"]').fill("2026-06-15");
  await page.locator('#planForm input[name="salary"]').fill("25000");
  await page.locator('#planForm input[name="survivalCost"]').fill("6000");
  await page.locator('#planForm input[name="buffer"]').fill("1000");
  await page.locator('#planForm input[name="investmentFixed"]').fill("2000");
  await page.locator('#planForm button[type="submit"]').click();

  await expect(page.locator("#topPlanName")).toHaveText("E2E salary");
  await expect(page.getByText("25 000 грн").first()).toBeVisible();

  await page.locator('.sidebar .nav-item[data-view="queue"]').click();
  await expect(
    page.getByRole("heading", { name: "Очередь желаний" }),
  ).toBeVisible();
  await page.locator('#quickAddForm input[name="title"]').fill("E2E laptop");
  await page.locator('#quickAddForm input[name="cost"]').fill("5000");
  await page.locator('#quickAddForm select[name="type"]').selectOption("must");
  await page.locator('#quickAddForm button[type="submit"]').click();

  const itemRow = page.locator("tr", { hasText: "E2E laptop" }).first();
  await expect(itemRow).toBeVisible();
  await expect(itemRow).toContainText("в плане");
});
